// web/app/api/admin/capabilities/route.ts
// W1 Task6：能力目录辅助页数据（W1 退出判据「辅助页可看 synced 状态」落点）。
// 返回 catalog 单真相全量 + 校验结果（环检测/通配风险）+ resource synced 状态 + 在线对账红区。
//   synced：syncResources 差集只插（add-resource 幂等）——辅助页查看即自愈；
//           Casdoor 不可达 → unknown 降级不阻塞页面（plan Task6 Step1）。
//   reconcile：permissions vs catalog 在线对账（Task 5 语义同源的 web 侧核心）；失败降级 null。
// 门禁：requireAdmin（data-analysis:admin，web/lib/admin-api-auth.ts）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { capabilityCatalog, DEPRECATED_KEYS, VIEW_GROUPS, displayNameFor } from '@/lib/capability-catalog';
import { detectViewGroupCycle, validateWildcardRisk } from '@/lib/validate-capabilities';
import { classifyCatalogReconcile, fetchCasdoorPermissions, type ReconcileResult } from '@/lib/reconcile-catalog';
import { syncResources } from '@/lib/sync/resource-sync';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req);
  if (deny) return deny;

  // synced 状态：resource 注册表 vs catalog 差集（查看即自愈；失败 → unknown 降级）
  let synced: { ok: boolean; unknown?: boolean; missing: string[]; added: string[] } = {
    ok: false, unknown: true, missing: [], added: [],
  };
  let syncFailures: { key: string; error: string }[] = [];
  try {
    const r = await syncResources(process.env.CASDOOR_ORG || 'shanhai');
    synced = { ok: r.failed.length === 0, missing: r.failed.map((f) => f.key), added: r.added };
    syncFailures = r.failed;
  } catch { /* Casdoor 不可达 → unknown 降级，页面显示降级态 */ }

  // 在线对账（红区 + 通配持有者）；拉取失败降级 null（页面提示对账不可用）
  let reconcile: (ReconcileResult & { summary?: { red: number; minor: number } }) | null = null;
  try {
    const permissions = await fetchCasdoorPermissions();
    const d = classifyCatalogReconcile({ permissions, syncFailures });
    reconcile = { ...d, summary: { red: d.red.length, minor: d.minor.length } };
  } catch { reconcile = null; }

  // 通配高风险（Task 3 校验器）：对账侧 permissions 引用的 data-analysis:* 命名空间通配
  const referencedResources = reconcile
    ? [...new Set((reconcile.wildcardHolders ?? []).map((w) => w.wildcard))]
    : [];

  // BREAKGLASS 应急后门可视化（2026-08-18）：非空 = 全权限旁路开启中——能力页琥珀横幅提示，
  // 防无声长期存在（张铎案例：调试时加入，一一个月无人知）。
  const breakglass = (process.env.BREAKGLASS_ADMINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  return NextResponse.json({
    catalogV: process.env.CATALOG_V ?? '0',
    breakglass,
    // 2026-08-18：附授权名（组|通俗名，= Casdoor resource.name / permission Custom 粘贴串），供能力页一键复制
    entries: capabilityCatalog.map((e) => ({ ...e, displayName: displayNameFor(e.key) })),
    deprecated: [...DEPRECATED_KEYS],
    viewGroups: VIEW_GROUPS,
    cycleCheck: detectViewGroupCycle(),
    wildcardRisk: validateWildcardRisk(referencedResources),
    synced,
    reconcile,
  });
}
