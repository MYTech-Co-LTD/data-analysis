// web/lib/sync/resource-sync.ts
// resource 注册 adapter（spec §5.1 ③）：Casdoor 原生 add-resource，只增改不删。
// ★L2：同步失败若静默跳过 → 能力永不可配——逐 key 结果显式反馈，failed 进对账红区。
// 2026-08-17（T6 真机取证，H3 怪癖勘误）：上游 Casdoor 文档要求 resource name 带 "/" 前缀；
//   但生产镜像 casbin/casdoor:latest（opsh 113.249.101.33）行为不同——get-resources 返回裸 name
//   （无 "/"），且 add-resource 对含 "/" 或 ":" 的 name 直接拒（字段校验 Field 'name' contains
//   forbidden characters: "/?:#&%=+;"）。旧实现写 "/key" 前缀 → 21/21 全被拒（红区误导为"禁 /"）。
//   修复：写入与比对都用裸 key（无前缀归一）；带 ":" 的 catalog key 仍会被 fork 拒（平台限制，
//   见 reconcile-catalog 的 known-limitation 登记，不静默）。
// 2026-08-17 打通（资源映射）：catalog key 含 ":"（Casdoor 字段校验禁），resource 表无法直接
//   写原文 → name 用合法映射名（":"→"_"；当前 catalog 无 "_"，映射无歧义）+ description 存
//   catalog key 原文（权威可逆：即使推导歧义，description 是可信源）。Casdoor 管理面显示映射名，
//   主管理面在 /admin/capabilities（catalog 原文）。约束：catalog key 不得含 "_"（scan 纪律）。
// 2026-08-17 方案甲（Casdoor 下拉显示通俗名）：看板/KPI 能力（capability-board 单真相有通俗名）的
//   resource.name 直接用通俗名（人类可读，Casdoor 下拉框显示的就是它）；无通俗名的（view:*/brand:*等）
//   仍用映射名。description 恒存 key 原文（权威可逆，fetchRemoteKeys/对账照旧）。
//   ⚠ 约束：通俗名必须全局唯一（capability-board 加载时断言防重名——Casdoor resource name 主键），
//   否则 add-resource 撞 PK / BY_NAME 反查歧义。
// 契约适配（T4 实施取证，2026-08-16）：casdoor-client 的 casdoorFetch 不抛异常，失败返回
//   { ok: false, error }——plan 原文的 try/catch 只覆盖 reject 形态；此处把 ok === false 归一为
//   同一失败路径（throw 进 catch），mock 测试返回体无 ok 字段不受影响（undefined !== false）。
import { casdoorFetch } from './casdoor-client';
import { CATALOG_KEYS, DEPRECATED_KEYS } from '../capability-catalog';
import { BOARD_CAPABILITY_BY_KEY, KPI_CARD_CAPABILITY_BY_KEY } from '../capability-board';

export interface SyncReport {
  added: string[]; skippedExisting: string[]; failed: { key: string; error: string }[];
}

// 资源映射（2026-08-17 打通）：catalog key ↔ Casdoor name。name 须避开 fork 禁字符
// （/?:#&%=+;），":" 是 catalog 三段式分隔 → 映射为 "_"。description 存 key 原文（权威）。
const enc = (key: string): string => key.replace(/:/g, '_');
const dec = (name: string): string => name.replace(/_/g, ':');   // 仅老数据/兜底；新数据走 description

// 通俗名 → Casdoor resource.name（方案甲）：有通俗名的能力（看板/KPI）用通俗名做展示名，
// 无通俗名的退回映射名。
function displayName(key: string): string {
  return (
    BOARD_CAPABILITY_BY_KEY.get(key)?.name ??
    KPI_CARD_CAPABILITY_BY_KEY.get(key)?.name ??
    enc(key)
  );
}

type ResourceRow = { name?: string; description?: string };

type FetchResult = { ok?: boolean; data?: unknown; error?: string };

async function fetchRemoteKeys(owner: string): Promise<Set<string>> {
  const resp = (await casdoorFetch('/api/get-resources?owner=' + encodeURIComponent(owner), {})) as FetchResult | undefined;
  // 2026-08-17 勘误（casdoorFetch data=body 解包坑，与 assignRoles 同源）：casdoorFetch 返回的
  //   data 是完整 response body {status, data:[...]}，不是直接数组。旧实现 Array.isArray(resp.data)
  //   恒 false → 空集 → 全量 add → 首次插入成功（掩盖 bug），表已有后重复 add 撞 resource_pkey 主键
  //   （能力页面全红 C-sync-failed）。兼容两形态：body 直接数组（mock/旧响应）或 body.data 数组。
  const body = resp?.data as { data?: unknown } | null | unknown[] | undefined;
  const rows = (Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown } | null)?.data)
      ? (body as { data: ResourceRow[] }).data
      : []) as ResourceRow[];
  // description 存 catalog key 原文（权威）；老数据无 description 时回退 decode(name)
  return new Set(rows.map((r) => r.description || dec(r.name ?? '')));
}

export async function syncResources(owner: string, keys?: readonly string[]): Promise<SyncReport> {
  const want = keys ?? [...CATALOG_KEYS];                       // 默认全 catalog（deprecated 不注册）
  const list = want.filter((k) => !DEPRECATED_KEYS.has(k));
  const have = await fetchRemoteKeys(owner);
  const report: SyncReport = { added: [], skippedExisting: [], failed: [] };
  for (const key of list) {
    if (have.has(key)) { report.skippedExisting.push(key); continue; }
    try {
      const res = (await casdoorFetch('/api/add-resource', {
        method: 'POST',
        body: JSON.stringify({ owner, name: displayName(key), description: key }),   // 通俗名 + 原文 description
      })) as FetchResult | undefined;
      if (res?.ok === false) throw new Error(res.error ?? 'add-resource failed');   // 真实通道失败归一（L2）
      // ★Casdoor body 级失败（生产实测 2026-08-17）：add-resource 可能 HTTP 200 但 body
      //   {status:'error', msg:"Field 'name' contains forbidden characters ..."}
      //   （fork 内置字段校验禁 "/?:#&%=+;"——含 ':' 的 catalog key 全被拒，架构 §6.4「adapter 待修」）。
      //   只查 HTTP 层会误报 added（L2 静默失败），必须按 body status 判红。
      const body = res?.data as { status?: string; msg?: string } | undefined;
      if (body?.status === 'error') throw new Error(body.msg ?? 'add-resource body error');
      report.added.push(key);
    } catch (e1) {
      try {                                                       // 并发撞 PK → 重读确认已被插过
        const have2 = await fetchRemoteKeys(owner);
        if (have2.has(key)) { report.added.push(key); continue; }
      } catch { /* fallthrough to failed */ }
      report.failed.push({ key, error: e1 instanceof Error ? e1.message : String(e1) });
    }
  }
  return report;
}
