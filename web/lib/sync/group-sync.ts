// web/lib/sync/group-sync.ts
// 组同步器（spec §5.3）——唯一自写组件。两通道分离（H2）：
//   部门树 = 企微源 upsert；门店树 = diff(dim_branch vs maps_branch_group vs Group 树) 驱动，
//   门店在企微未必有部门，门店通道禁挂企微 webhook。
// 先父后子（H1）：ParentId 存父 Name，父链断裂 → 原生 GetUserFullGroupPath error → 整组 JWT 签发失败。
// 删除限于自建（properties.createdBy='group-sync' 标记）；门店停用 = is_enabled=false 非真删。
// 相对 plan L822-904 的两处适配（详见 .superpowers/report.md）：
//   ① PostgREST env 名加仓库既有约定回退（INSFORGE_URL || NEXT_PUBLIC_INSFORGE_URL，同 collect-items.ts）
//   ② maps upsert 补 on_conflict=branch_number（178 表 UNIQUE(branch_number)，幂等真 upsert）
import { casdoorFetch } from './casdoor-client';

export interface GroupUpserResult { created: string[]; updated: string[]; }

// 仓库既有 env 约定：collect-items.ts 用 NEXT_PUBLIC_INSFORGE_*（服务端同样可见），plan 原文的裸
// INSFORGE_URL/INSFORGE_ANON_KEY 保留为首选，避免环境漏配静默空串（CLAUDE.md 教训）。
// 函数内求值（非模块级 const）：测试可 vi.stubEnv 注入端点形态；模块级固化会把空串焊死到调用点。
function insforgeEnv() {
  return {
    url: process.env.INSFORGE_URL || process.env.NEXT_PUBLIC_INSFORGE_URL || '',
    anonKey: process.env.INSFORGE_ANON_KEY || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY || '',
  };
}

export async function upsertGroup(owner: string, name: string, parentName: string | null, type: 'store'|'region'|'dept'): Promise<void> {
  const existing = await casdoorFetch(`/api/get-groups?owner=${encodeURIComponent(owner)}`, {});
  const have = new Set(((existing as { data?: { name?: string }[] }).data ?? []).map((g) => g.name ?? ''));
  // ★先父后子：父不存在则先建父（递归一层足够——树深 ≤3：品牌→区域→门店）
  if (parentName && !have.has(parentName)) {
    await casdoorFetch('/api/add-group', {
      method: 'POST',
      body: JSON.stringify({
        owner, name: parentName, type: 'Virtual',
        parentId: '',                                       // 门店树根（品牌链）父=org 顶
        properties: JSON.stringify({ createdBy: 'group-sync', groupType: 'region' }),
        isEnabled: true,
      }),
    });
    have.add(parentName);
  }
  if (!have.has(name)) {
    await casdoorFetch('/api/add-group', {
      method: 'POST',
      body: JSON.stringify({
        owner, name, type: 'Virtual',
        parentId: parentName ?? '',
        properties: JSON.stringify({ createdBy: 'group-sync', groupType: type }),
        isEnabled: true,
      }),
    });
  }
}

export async function syncStoreTree(): Promise<{ created: { branch_number: string; group_name: string }[]; renamed: string[] }> {
  // 三源：dim_branch（真源）/ maps_branch_group（映射）/ Group 树（Casdoor）
  // T8 死传输修复（DW1 review 跟踪#1，2026-08-16）：原 casdoorFetch('/api/get-branches?...') 把 PostgREST
  // 语法打 Casdoor 域名——生产必 404 → 门店树永不建（绿测试因 mock 掩盖）。dim_branch 是库内表，改走
  // PostgREST 真实端点（T9 group-expand 同款先例：绝对 URL 经 casdoorFetch 直传 + apikey/Bearer 覆盖 Casdoor token）。
  const { url: INSFORGE_URL, anonKey: INSFORGE_ANON_KEY } = insforgeEnv();
  const branches = await casdoorFetch(
    `${INSFORGE_URL}/dim_branch?select=branch_number,branch_name,system_book_code&is_active=eq.true`,
    { headers: { apikey: INSFORGE_ANON_KEY, Authorization: `Bearer ${INSFORGE_ANON_KEY}` } },
  );
  const groups = await casdoorFetch('/api/get-groups?owner=shanhai', {});
  const maps = await fetch(`${INSFORGE_URL}/maps_branch_group?is_active=eq.true`, {
    headers: { apikey: INSFORGE_ANON_KEY },
  }).then((r) => r.json()) as { branch_number: string; group_id: string }[];
  const groupNames = new Set(((groups as { data?: { name?: string }[] }).data ?? []).map((g) => g.name ?? ''));
  const mapped = new Set(maps.map((m) => m.branch_number));
  const created: { branch_number: string; group_name: string }[] = [];
  // PostgREST 返回裸数组（casdoorFetch 把它放进 .data；Casdoor API 的 {data:[...]} 双层包装不适用于此端点）
  for (const b of (branches as { data?: { branch_number: string; branch_name: string; system_book_code: string }[] }).data ?? []) {
    if (mapped.has(b.branch_number)) continue;
    // 组名含 branch_number（全局唯一），区域父组按 dim_branch 区域字段——此处用品牌链根占位，区域细分由 Task 10 对账驱动补
    const region = `${b.system_book_code === '3120' ? '熊喵' : '品品甜'}`;
    const groupName = `${region}-${b.branch_number}`;
    await upsertGroup('shanhai', groupName, region, 'store');
    await fetch(`${INSFORGE_URL}/maps_branch_group?on_conflict=branch_number`, {
      method: 'POST',
      headers: { apikey: INSFORGE_ANON_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ branch_number: b.branch_number, group_id: groupName, group_name: groupName, group_type: 'store', source: 'auto' }),
    });
    created.push({ branch_number: b.branch_number, group_name: groupName });
  }
  return { created, renamed: [] };
}

export function verifyParentChain(groups: { name: string; parentId: string }[]): { group: string; parent: string }[] {
  const names = new Set(groups.map((g) => g.name));
  return groups.filter((g) => g.parentId && !names.has(g.parentId))
    .map((g) => ({ group: g.name, parent: g.parentId }));
}

export function deletableGroups(groups: { name: string; properties: string }[]): string[] {
  return groups.filter((g) => {
    try { return JSON.parse(g.properties || '{}').createdBy === 'group-sync'; } catch { return false; }
  }).map((g) => g.name);
}

export async function syncDeptTree(_depts: unknown): Promise<GroupUpserResult> {
  // 部门通道（企微 webhook / 03:17 全量 → upsert 部门组）——接线到既有 org_departments 同步链后启用；
  // W2 影子期只写不读，部门组 group_type='dept' 不参与 branch 展开（H13 三态）。
  return { created: [], updated: [] };
}
