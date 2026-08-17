// web/lib/reconcile-catalog.ts
// W1 Task6：catalog 对账核心（web 侧）——/api/admin/capabilities 辅助页与 cron job（03:47）共用。
// 语义基线 = scripts/reconcile-catalog.mjs（Task 5 CLI 门禁版）同源对齐，判定集合从
// capability-catalog 单真相取缺省（H12 不立副本）；E-unknown/E-deprecated/C-sync-failed 红、
// M-unreferenced 提示、wildcardHolders 单列（M2 通配风险面，含 push:* 引擎裸 key）。
// 与 scripts 侧的分工：CLI 版 = CI/SSH 门禁（exit 1）；本模块 = 运行时在线对账（页面 + 告警）。
import { casdoorFetch } from './sync/casdoor-client';
import { CATALOG_KEYS, DEPRECATED_KEYS } from './capability-catalog';
import { BOARD_CAPABILITY_BY_NAME, KPI_CARD_CAPABILITY_BY_NAME } from './capability-board';

export interface CasdoorPermission {
  name: string;
  resources?: string[];
}

export type RedEntry =
  | { kind: 'E-unknown-key'; key: string; holders: string[] }
  | { kind: 'E-deprecated-key'; key: string; holders: string[] }
  | { kind: 'C-sync-failed'; key: string; holders: string[]; error: string };

export interface ReconcileResult {
  red: RedEntry[];
  minor: { kind: 'M-unreferenced'; key: string }[];
  wildcardHolders: { user: string; wildcard: string }[];
}

const NS = 'data-analysis:';
const shortWild = (w: string): string => w.replace(/^data-analysis:/, '');

/**
 * 对账分类（纯函数，集合可注入便于测试；缺省 = catalog 单真相）。
 * @param permissions Casdoor permission 列表（resources 为真授权语义，F11；名字恒带 "/" 前缀的 H3 怪癖在此归一）
 * @param syncFailures resource-sync（Task 4）失败通道——能力注册失败 = 永不可配，喂 C-sync-failed 红（L2 不静默）
 */
export function classifyCatalogReconcile({
  permissions,
  catalog = CATALOG_KEYS,
  deprecated = DEPRECATED_KEYS,
  syncFailures = [],
}: {
  permissions: readonly CasdoorPermission[];
  catalog?: ReadonlySet<string>;
  deprecated?: ReadonlySet<string>;
  syncFailures?: readonly { key: string; error: string }[];
}): ReconcileResult {
  const red: RedEntry[] = [];
  const minor: ReconcileResult['minor'] = [];
  const wildcardHolders: ReconcileResult['wildcardHolders'] = [];

  // 引用并集：key → holders[]（持有全局 '*' 的 permission 标注 (*)）
  const referenced = new Map<string, string[]>();
  // 归一（方案甲）：Casdoor 下拉选中通俗名写进 permission.resources 时，先把通俗名还原成
  //   能力 key 再进 referenced（否则 E-unknown-key 误报 / M-unreferenced 漏报）。
  const normKey = (r: string): string =>
    BOARD_CAPABILITY_BY_NAME.get(r)?.key ?? KPI_CARD_CAPABILITY_BY_NAME.get(r)?.key ?? r;
  for (const p of permissions) {
    // H3：get-resources 系名恒带 "/" 前缀，permission.resources 同源勾选面——比对前统一剥离
    const rs = (p.resources ?? []).map((r) => String(r).replace(/^\//, ''));
    for (const r of rs) {
      const key = normKey(r);
      if (!referenced.has(key)) referenced.set(key, []);
      referenced.get(key)!.push(rs.includes('*') ? `${p.name}(*)` : p.name);
    }
    for (const w of rs.filter((r) => r === '*' || r.endsWith(':*')))
      wildcardHolders.push({ user: p.name, wildcard: w });
  }

  // C-sync-failed：注册失败通道（红）
  for (const f of syncFailures)
    red.push({ kind: 'C-sync-failed', key: f.key, holders: ['resource-sync'], error: f.error });

  // E-unknown-key：data-analysis:* 命名空间内非通配 key 不在 catalog（反向发现）
  for (const [key, holders] of referenced) {
    if (key === '*' || key.endsWith(':*')) continue;      // 通配本身合法（spec §5.7 残余声明）
    if (!key.startsWith(NS)) continue;                    // 范围外（push:* 引擎裸 key，H4）
    if (deprecated.has(key)) continue;                    // 废弃走下方三源合并通道
    if (!catalog.has(key)) red.push({ kind: 'E-unknown-key', key, holders });
  }

  // E-deprecated-key（M2 核心）：直接引用 ∪ 命名空间通配覆盖 ∪ 全局 '*'，holders 显式展开；
  // 无任何持有者的废弃 key 不算红（驱逐判据之一：对账红区清零）。
  for (const key of deprecated) {
    const holders = new Set<string>();
    for (const p of permissions) {
      const rs = (p.resources ?? []).map((r) => String(r).replace(/^\//, ''));
      if (rs.includes('*')) { holders.add(`${p.name}(*)`); continue; }
      if (rs.includes(key)) holders.add(p.name);
      for (const w of rs)
        if (w !== '*' && w.endsWith(':*') && key.startsWith(w.slice(0, -1)))   // view:* 覆盖 view:xxx
          holders.add(`${p.name}(${shortWild(w)})`);
    }
    if (holders.size) red.push({ kind: 'E-deprecated-key', key, holders: [...holders] });
  }
  red.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // M-unreferenced：catalog 内 key 未被直接引用（可配但没人配——提示，不算红）
  for (const key of catalog) if (!referenced.has(key)) minor.push({ kind: 'M-unreferenced', key });
  minor.sort((a, b) => (a.key < b.key ? -1 : 1));

  return { red, minor, wildcardHolders };
}

/**
 * 拉取 Casdoor permissions（真授权语义，F11）。经 casdoorFetch（client_credentials 同款）；
 * 失败 throw——调用方（API 路由）降级 null 不阻塞页面，cron 则整体 error 告警。
 */
export async function fetchCasdoorPermissions(): Promise<CasdoorPermission[]> {
  const org = process.env.CASDOOR_ORG || 'shanhai';
  const resp = await casdoorFetch(`/api/get-permissions?owner=${encodeURIComponent(org)}`, {});
  if (resp.ok === false) throw new Error(resp.error ?? 'get-permissions failed');
  // Casdoor 返回形态兼容：裸数组 或 { data: [...] }
  const body = resp.data;
  const list = Array.isArray(body) ? body : ((body as { data?: unknown } | null)?.data ?? []);
  return (Array.isArray(list) ? list : []) as CasdoorPermission[];
}
