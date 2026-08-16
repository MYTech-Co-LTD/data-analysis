// web/lib/sync/resource-sync.ts
// resource 注册 adapter（spec §5.1 ③）：Casdoor 原生 add-resource，只增改不删。
// ★H3 怪癖（代码注释钉死，V2 源码验证项）：add-resource = 裸 Insert（PK=owner+name，重复即报错）；
//   GetResource/get-resources 查表恒加 "/" 前缀 → 写入与比对都统一 "/" 前缀归一化。
// ★L2：同步失败若静默跳过 → 能力永不可配——逐 key 结果显式反馈，failed 进对账红区。
// 契约适配（T4 实施取证，2026-08-16）：casdoor-client 的 casdoorFetch 不抛异常，失败返回
//   { ok: false, error }——plan 原文的 try/catch 只覆盖 reject 形态；此处把 ok === false 归一为
//   同一失败路径（throw 进 catch），mock 测试返回体无 ok 字段不受影响（undefined !== false）。
import { casdoorFetch } from './casdoor-client';
import { CATALOG_KEYS, DEPRECATED_KEYS } from '../capability-catalog';

const norm = (name: string): string => (name.startsWith('/') ? name : `/${name}`);
const denorm = (name: string): string => name.replace(/^\//, '');

export interface SyncReport {
  added: string[]; skippedExisting: string[]; failed: { key: string; error: string }[];
}

type FetchResult = { ok?: boolean; data?: unknown; error?: string };

async function fetchRemoteKeys(owner: string): Promise<Set<string>> {
  const resp = (await casdoorFetch('/api/get-resources?owner=' + encodeURIComponent(owner), {})) as FetchResult | undefined;
  const rows = (Array.isArray(resp?.data) ? resp.data : []) as { name?: string }[];
  return new Set(rows.map((r) => denorm(r.name ?? '')));
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
        body: JSON.stringify({ owner, name: norm(key) }),       // ← "/" 前缀归一（H3）
      })) as FetchResult | undefined;
      if (res?.ok === false) throw new Error(res.error ?? 'add-resource failed');   // 真实通道失败归一（L2）
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
