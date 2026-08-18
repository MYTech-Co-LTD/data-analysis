#!/usr/bin/env node
// scripts/migrate-perms-friendly.mjs —— 方案 C 生产迁移（2026-08-17）
// 目标：5 个 role-* permission.resources 从「原始 key + 11 个退役死 key」改写为
//   「保留具名能力的通俗名 + 通配 key（view-board:* / view-kpi:*）+ 退役 key 删除」。
// 结果：Casdoor 权限页显示通俗名（人读名称），get-all-objects 返回通俗名 → claims.js 反查 key。
//
// ⚠ update-permission 必须带完整字段（name/owner/users/groups/roles/resources/actions/effect/
//   isEnabled）——.AllCols().Update() 会清空未传字段（Casdoor object/permission.go:175 教训，
//   历史 commit 186a5ab 已踩坑：旧 data-analysis-basic/full 权限被清空后删除）。
//
// 用法（--live 才真调 Casdoor，默认 dry-run 打印 plan）：
//   node scripts/migrate-perms-friendly.mjs [--live]
//
// 参考模式：scripts/reconcile-catalog.mjs（client_credentials + get-permissions 同款）；
//   env：CASDOOR_API_URL / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET / CASDOOR_ORG（deploy/.env 注入）。
import { pathToFileURL } from 'node:url';

const CASDOOR_API = process.env.CASDOOR_API_URL || process.env.CASDOOR_API || 'https://sso.shanhaiyiguo.com';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';

// 通俗名表（与 capability-catalog.ts 同步；脚本间不 import 防耦合——静态镜像，claims.js 同源）
// 只列具名能力（10 条）。看板/KPI 具名 key 生产 role-* 用的是通配（view-board:* / view-kpi:*），
// 迁移时不翻译（通配保留原样）；若出现具名看板/KPI key 则原样透传（安全兜底，不退通俗名）。
const KEY_TO_LABEL = {
  'data-analysis:view:reports': '经营总览',
  'data-analysis:view:reports-targets': '目标达成',
  'data-analysis:view-group:reports-all': '报表看板全组',
  'data-analysis:brand:3120': '熊喵鲜生',
  'data-analysis:brand:64188': '品品甜',
  'data-analysis:category:水果': '水果',
  'data-analysis:category:标品': '标品',
  'data-analysis:category:耗材': '耗材',
  'data-analysis:field:cost': '成本可见',
  'data-analysis:admin': '管理台',
};

// 退役 11 个 key（从 permission.resources 删除；T1 catalog DEPRECATED 同源清单）
const RETIRED = [
  'data-analysis:view:mobile',
  'data-analysis:view:report_brand_metric_gen',
  'data-analysis:view:report_category_summary_gen',
  'data-analysis:view:report_item_breakdown_gen',
  'data-analysis:view:report_region_breakdown_gen',
  'data-analysis:view:report_supply_chain_outbound_gen',
  'data-analysis:view:report_wholesale_customer_gen',
  'data-analysis:view:report_wholesale_daily_customer_gen',
  'data-analysis:view:report_wholesale_daily_gen',
  'data-analysis:view:reports-items',
  'data-analysis:view:wholesale-customers',
];

// 迁移：key → 通俗名（具名）；通配（view-board:* / view-kpi:* / *）保留原样；退役 key 删除
export function migrateResources(resources) {
  const out = [];
  for (const r of resources) {
    if (RETIRED.includes(r)) continue;                                  // 退役删除
    if (r === '*' || r.endsWith(':*')) { out.push(r); continue; }       // 通配保留原样
    const label = KEY_TO_LABEL[r] ?? r;                                 // 具名 → 通俗名（未知名兜底保留原 key）
    if (!out.includes(label)) out.push(label);                          // 去重（通俗名可能已存在）
  }
  return out;
}

// ---- client_credentials（与 scripts/reconcile-catalog.mjs 同款；真实通道失败归一为 throw，exit 2） ----
async function getAccessToken() {
  const resp = await fetch(`${CASDOOR_API}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: process.env.CASDOOR_CLIENT_ID || '',
      client_secret: process.env.CASDOOR_CLIENT_SECRET || '', scope: 'openid',
    }),
  });
  if (!resp.ok) throw new Error(`token fetch failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error('token response missing access_token');
  return data.access_token;
}

async function fetchPermissions(token) {
  const resp = await fetch(`${CASDOOR_API}/api/get-permissions?owner=${encodeURIComponent(CASDOOR_ORG)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`get-permissions failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  const j = await resp.json().catch(() => null);
  return Array.isArray(j) ? j : (j?.data ?? []);
}

// update-permission：带完整字段（防 .AllCols().Update() 清空未传字段）
async function updatePermission(token, perm) {
  const resp = await fetch(`${CASDOOR_API}/api/update-permission?id=${encodeURIComponent(perm.owner + '/' + perm.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      owner: perm.owner,
      name: perm.name,
      displayName: perm.displayName ?? '',
      description: perm.description ?? '',
      users: perm.users ?? [],
      groups: perm.groups ?? [],
      roles: perm.roles ?? [],
      domains: perm.domains ?? [],
      resources: perm.resources ?? [],
      actions: perm.actions ?? [],
      effect: perm.effect ?? 'Allow',
      isEnabled: perm.isEnabled ?? true,
    }),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok || (body && body.status === 'error')) {
    throw new Error(`update-permission ${perm.owner}/${perm.name} failed: ${resp.status} ${body?.msg ?? await resp.text().catch(() => '')}`);
  }
  return body;
}

async function main() {
  const live = process.argv.includes('--live');
  const clientId = process.env.CASDOOR_CLIENT_ID || '';
  const clientSecret = process.env.CASDOOR_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('缺 CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET（deploy/.env 注入）');

  const token = await getAccessToken();
  const perms = await fetchPermissions(token);
  const targets = perms.filter((p) => String(p.name || '').startsWith('role-'));

  if (!targets.length) {
    console.error('[migrate-perms-friendly] 未找到 role-* permission（可能 owner 或命名不同，请核对）');
    process.exit(2);
  }

  const changed = [];
  const untouched = [];
  for (const p of targets) {
    const before = (p.resources ?? []).map((r) => String(r));
    const after = migrateResources(before);
    const beforeNorm = [...before].sort();
    const afterNorm = [...after].sort();
    const isChanged = JSON.stringify(beforeNorm) !== JSON.stringify(afterNorm);
    const entry = {
      name: p.name,
      before,
      after,
      changed: isChanged,
      retiredRemoved: before.filter((r) => RETIRED.includes(r)),
      nowFriendly: after.filter((r) => Object.values(KEY_TO_LABEL).includes(r)),
    };
    if (isChanged) changed.push(entry); else untouched.push(entry);

    console.log(`\n[permission] ${p.name}（${p.owner}）${isChanged ? '★ 需迁移' : '✓ 无需变更'}`);
    if (isChanged) {
      console.log('  before:');
      for (const r of before) console.log(`    - ${r}`);
      console.log('  after:');
      for (const r of after) console.log(`    + ${r}`);
      if (entry.retiredRemoved.length) console.log(`  退役清除: ${entry.retiredRemoved.join(', ')}`);
    }
  }

  console.log(`\n[summary] role-* permission ${targets.length}：变更 ${changed.length} / 无需变更 ${untouched.length}`);

  if (live) {
    console.log('\n[--live] 开始写入...');
    for (const e of changed) {
      const target = targets.find((t) => t.name === e.name);
      const updated = { ...target, resources: e.after };
      const res = await updatePermission(token, updated);
      console.log(`  ✓ ${e.name}: update-permission ${res?.status ?? 'ok'} (resources ${e.before.length} → ${e.after.length})`);
    }
    console.log('\n[migrate-perms-friendly] 迁移完成');
  } else {
    console.log('\n[dry-run] 未写 Casdoor。确认后加 --live 执行。');
  }
}

// 入口守卫：被 import（node:test）时不跑 CLI，只有直接执行才进 main
const isEntry = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isEntry) {
  main().catch((e) => { console.error('[migrate-perms-friendly] Fatal:', e.message); process.exit(2); });
}
