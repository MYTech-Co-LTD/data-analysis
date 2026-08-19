// web/app/api/admin/permissions/preview/route.ts
// 生效权限预览：get_user_perms 合成结果 + 角色/部门/个人 override 各层来源（排障用）
// 167 迁移后 org_departments 已无 branch_nums/can_see_cost：部门层权限从 data_permissions(subject_type=dept) 行聚合（未配置→null）。
// ★2026-08-18 门店范围唯一真相：新增 target 字段 = 按「真实登录口径」推导的生效范围——
//   Casdoor get-all-objects（与登录 fetchAllObjects 同源并集，含角色挂载）→ 提取 范围|/品牌|/品类|/字段|
//   → 范围|X 经 scope-expand（claims.js resolveScopeKeys 的 web 版）展开成 branch_nums。
//   get_user_perms 现为 scope_resources 双形输出（方案 A，migration 200）：effective 读 data_scope/fields，
//   旧顶层四维仅供展示对照（M6 sunset 后仅 data_scope/fields）。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';
import { casdoorFetch } from '@/lib/sync/casdoor-client';
import { expandScopeResources } from '@/lib/sync/scope-expand';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const ORG = process.env.CASDOOR_ORG || 'shanhai';

export async function GET(req: NextRequest) {
  const deny = await requireAdmin(req); if (deny) return deny;
  const wecomId = req.nextUrl.searchParams.get('wecom_id');
  if (!wecomId) return NextResponse.json({ ok: false, error: '缺 wecom_id' }, { status: 400 });

  const [permsRes, userArr] = await Promise.all([
    fetch(`${POSTGREST_URL}/rpc/get_user_perms`, {
      method: 'POST', headers: H, body: JSON.stringify({ p_wecom_id: wecomId }),
    }).then(r => r.json()).catch(() => null),
    fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name,role_id,role_source,department_ids&wecom_id=eq.${encodeURIComponent(wecomId)}`, { headers: H, cache: 'no-store' })
      .then(r => r.json()).catch(() => []),
  ]);
  const user = Array.isArray(userArr) ? userArr[0] ?? null : null;

  // ★target（2026-08-18）：真实登录口径的生效范围——Casdoor get-all-objects 并集（含角色挂载），
  //   与登录 fetchAllObjects 同源；失败 → null（预览标记不可用，不阻断其余排障展示）。
  let target = null;
  try {
    const reachRes = await casdoorFetch(`/api/get-all-objects?userId=${ORG}/${encodeURIComponent(wecomId)}`);
    const reach = (reachRes.data as { data?: string[] } | null)?.data;
    if (Array.isArray(reach)) {
      const resources = reach.filter((r): r is string => typeof r === 'string');
      // 登录侧 normalizeFriendlyPerm 同时接受两种形态（范围|X 前缀规则 / 已归一 data-analysis:branch:X 原样透传），
      // preview 须同口径提取，否则 key 形态资源被漏 → 预览显示 deny 而登录放行（review I1）。
      const scopeRes = resources.filter((r) => r.startsWith('范围|') || r.startsWith('data-analysis:branch:'));
      const scopeKeys = scopeRes.map((r) =>
        r.startsWith('范围|') ? r.slice('范围|'.length) : r.slice('data-analysis:branch:'.length));
      const expanded = scopeKeys.length > 0 ? await expandScopeResources(scopeKeys) : { branch_nums: [] as string[], ok: true };
      target = {
        scopeResources: scopeRes,
        branch_nums: expanded.ok ? [...(expanded.branch_nums ?? [])] : [],
        expandError: expanded.ok ? null : (expanded.error ?? 'expand failed'),
        // 品牌/品类为友好名形态（如 熊喵鲜生）；登录 data_scope.brands 是 code（3120，经 FRIENDLY_TO_KEY 归一）——展示用，注意两形对照。
        brands: resources.filter((r) => r.startsWith('品牌|')).map((r) => r.slice('品牌|'.length)),
        categories: resources.filter((r) => r.startsWith('品类|')).map((r) => r.slice('品类|'.length)),
        fields: { cost: resources.includes('字段|成本可见') },
      };
    }
  } catch (e) {
    console.error('[preview] target scope unavailable', (e as Error).message);
  }

  const roleArr = user?.role_id
    ? await fetch(`${POSTGREST_URL}/roles?select=id,code,name&id=eq.${user.role_id}`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => [])
    : [];
  const deptIds: string[] = Array.isArray(user?.department_ids) ? user.department_ids : [];
  // org_departments 只取基础字段（167 起权限列已 DROP）；部门权限并列查 data_permissions(dept 行) 再合并
  const [depts, deptPerm] = deptIds.length
    ? await Promise.all([
        fetch(`${POSTGREST_URL}/org_departments?select=id,name&id=in.(${deptIds.map(x => `"${x}"`).join(',')})`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []),
        fetch(`${POSTGREST_URL}/data_permissions?select=subject_id,branch_nums,can_see_cost&subject_type=eq.dept&subject_id=in.(${deptIds.map(x => `"${x}"`).join(',')})`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []),
      ])
    : [[], []];
  const deptArr = Array.isArray(depts) ? depts : [];
  const deptPermArr = Array.isArray(deptPerm) ? deptPerm : [];
  const departments = deptArr.map((d: { id: string }) => {
    const p = deptPermArr.find((x: { subject_id: string }) => x.subject_id === d.id);
    return { ...d, branch_nums: p?.branch_nums ?? null, can_see_cost: p?.can_see_cost ?? null };
  });
  // data_permissions 无 RLS（072 设计：仅 SECURITY DEFINER 可读）；此处用 service key 直查（admin 已鉴权）
  // 168 起 role 行键 = roles.code（roleArr 上面已按 role_id 折出 code）
  const roleCode = Array.isArray(roleArr) ? roleArr[0]?.code ?? null : null;
  const subjectFilter = `or=(and(subject_type.eq.user,subject_id.eq.${encodeURIComponent(wecomId)}),and(subject_type.eq.role,subject_id.eq.${roleCode ?? '__no_role__'}))`;
  const perms = await fetch(`${POSTGREST_URL}/data_permissions?select=subject_type,subject_id,branch_nums,brands,categories,can_see_cost,expires_at,note&${subjectFilter}`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []);

  return NextResponse.json({
    effective: permsRes,
    layers: { user, role: roleArr?.[0] ?? null, departments, permissions: perms },
    // ★2026-08-18 门店范围唯一真相：target = 真实登录口径生效范围（范围|X 资源展开）；
    //   effective（get_user_perms）为 scope_resources 双形输出（200），读 data_scope/fields，仅对照。
    target,
  });
}
