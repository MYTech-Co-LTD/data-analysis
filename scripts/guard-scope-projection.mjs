#!/usr/bin/env node
// scripts/guard-scope-projection.mjs —— 投影覆盖守卫（方案 A，Wave1.5 硬门禁 M8/spec-forge）
//
// 判定：活跃用户中 scope_resources 非空占比 ≥ THRESHOLD（默认 0.9），低于则 exit 非 0。
// 用途：Wave2（M3 切换 get_user_perms 读投影）前硬门禁——空投影占比过高 → 全员 deny，禁止切换。
//
// 用法（在 deploy-web-1 容器内跑，复用 env）：
//   node guard-scope-projection.mjs            # 报告覆盖占比，低于阈值 exit 1
//   node guard-scope-projection.mjs --json     # 输出 JSON（供 CI/脚本消费）

const PGRST = process.env.POSTGREST_URL || 'http://postgrest:3000';
const PGRST_KEY = process.env.INSFORGE_API_KEY || '';
const THRESHOLD = Number(process.env.GUARD_THRESHOLD || '0.9');

const H = { apikey: PGRST_KEY, Authorization: `Bearer ${PGRST_KEY}` };

const resp = await fetch(`${PGRST}/org_users?select=scope_resources,is_active`, { headers: H });
if (!resp.ok) throw new Error(`org_users ${resp.status}: ${await resp.text()}`);
const rows = await resp.json();

const active = rows.filter((r) => r.is_active === true);
const nonEmpty = active.filter((r) => Array.isArray(r.scope_resources) && r.scope_resources.length > 0);
const ratio = active.length ? nonEmpty.length / active.length : 0;

const out = {
  active: active.length,
  nonEmpty: nonEmpty.length,
  ratio: Number(ratio.toFixed(4)),
  threshold: THRESHOLD,
  pass: ratio >= THRESHOLD,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`active=${out.active} nonEmpty=${out.nonEmpty} ratio=${(ratio * 100).toFixed(1)}% threshold=${(THRESHOLD * 100).toFixed(0)}% → ${out.pass ? 'PASS' : 'FAIL'}`);
}

process.exit(out.pass ? 0 : 1);
