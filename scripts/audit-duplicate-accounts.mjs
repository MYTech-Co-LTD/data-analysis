#!/usr/bin/env node
// scripts/audit-duplicate-accounts.mjs
// Casdoor 大小写重复账号巡检 + 绑定迁移（2026-10-04 事故，issue #83）。
//
// 事故链：批量导入人员把企微账号（userid）的大小写改了（`YangWei` → `yangwei`）。
//   企微的 userid 查询大小写不敏感（user/get?userid=zhangduo|ZhangDuo 都返回 ZhangDuo），
//   但 Casdoor 的企微 provider 用 provider 返回的 userid 当**外部身份键**
//   （properties.oauth_WeCom_id）做**区分大小写**的精确匹配，匹配不到就走 JIT 建号
//   → 同一个人被判成两个账号（老账号 id 是名字，新账号 id 是 UUID）。
//   角色/分组绑定留在老账号上 → 实际登录的新账号 groups 空 / reachable 空
//   → claims fail-close（buildClaims 返回 null）→ 边沿函数 503 → 前端只显示 "InsForgeError"。
//
// 用法：
//   node scripts/audit-duplicate-accounts.mjs           # dry-run：只出报表；有「必须修」缺口时退出码 1
//   node scripts/audit-duplicate-accounts.mjs --apply   # 把遗留账号的角色/分组绑定迁到企微当前账号
//
// env：
//   CASDOOR_API_URL / CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET / CASDOOR_ORG（必填）
//   WECOM_CORP_ID / WECOM_OPS_SECRET（可选；解析企微当前 userid，判定「现在能登录的那个」账号。
//     缺省时无法判定当前账号 → 只报不改，--apply 会拒绝执行）
//
// 边界：本脚本只写 role.users / group.users（Casdoor update-role / update-group 整对象替换），
//   不碰 user 对象（update-user 是整对象替换且带密码字段，有洗掉 passwordType 的风险）。
//   遗留账号的**停用/删除**留人工在 Casdoor 管理台做（报表里给提示）——绑定清空后它已无法被登录命中。
// 迁移口径：角色必迁；分组只在「企微当前账号一个组都没有」时兜底迁入（登录 groups 闸要求非空），
//   当前号已有组则不动——遗留号上多出来的组是过期归属，归薄同步按当前部门维护。

const CASDOOR_API = process.env.CASDOOR_API_URL || process.env.CASDOOR_API || 'https://sso.shanhaiyiguo.com';
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || '';
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || '';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';
const WECOM_CORP_ID = process.env.WECOM_CORP_ID || '';
const WECOM_OPS_SECRET = process.env.WECOM_OPS_SECRET || '';
const APPLY = process.argv.includes('--apply');

if (!CASDOOR_CLIENT_ID || !CASDOOR_CLIENT_SECRET) {
  console.error('❌ 缺 env：CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET');
  process.exit(2);
}

// ---- Casdoor API ----
async function casdoor(token, path, method = 'GET', body) {
  const resp = await fetch(`${CASDOOR_API}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!resp.ok) throw new Error(`${method} ${path} → ${resp.status} ${text.slice(0, 200)}`);
  // Casdoor 的经典陷阱：写端点常回 HTTP 200 + body {status:'error', msg}（假绿）。
  // 只看 HTTP 状态码会把失败当成功（本脚本首版就踩了：迁移“成功 0 · 失败 5”却无异常）。
  if (j && typeof j === 'object' && j.status === 'error') {
    throw new Error(`${method} ${path} → body error: ${j.msg ?? text.slice(0, 200)}`);
  }
  return j;
}

const unwrap = (body) => (Array.isArray(body) ? body : (body?.data ?? []));

const tokResp = await casdoor(null, '/api/login/oauth/access_token', 'POST', {
  grant_type: 'client_credentials',
  client_id: CASDOOR_CLIENT_ID,
  client_secret: CASDOOR_CLIENT_SECRET,
  scope: 'openid',
});
const token = tokResp?.access_token;
if (!token) { console.error('❌ no access_token'); process.exit(2); }

const users = unwrap(await casdoor(token, `/api/get-users?owner=${encodeURIComponent(CASDOOR_ORG)}`));
const roles = unwrap(await casdoor(token, `/api/get-roles?owner=${encodeURIComponent(CASDOOR_ORG)}`));
const groups = unwrap(await casdoor(token, `/api/get-groups?owner=${encodeURIComponent(CASDOOR_ORG)}`));

const bare = (id) => String(id).split('/').pop();

// 反向索引：账号名 → 所在角色/分组
const rolesOf = new Map();
const groupsOf = new Map();
for (const r of roles) {
  for (const u of (r.users ?? [])) {
    const n = bare(u);
    if (!rolesOf.has(n)) rolesOf.set(n, new Set());
    rolesOf.get(n).add(r.name);
  }
}
for (const g of groups) {
  for (const u of (g.users ?? [])) {
    const n = bare(u);
    if (!groupsOf.has(n)) groupsOf.set(n, new Set());
    groupsOf.get(n).add(g.name);
  }
}

// ---- 企微当前 userid 解析（大小写不敏感；返回账号的权威拼写）----
// 企微解析状态：'ok' | 'no_creds' | `api_error:<errcode> <errmsg>`
// ⚠️ 企微服务端 API 受「企业可信IP」约束：从非白名单机器跑会拿 60020
//    （gettoken 豁免白名单 → 预检绿，但 user/get 会被拦）——本脚本须在实例机/白名单主机上跑。
let wecomStatus = !WECOM_CORP_ID || !WECOM_OPS_SECRET ? 'no_creds' : 'ok';
let wecomToken = null;
async function wecomCanonical(name) {
  if (wecomStatus === 'no_creds') return null;
  if (wecomToken === null) {
    const t = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(WECOM_CORP_ID)}&corpsecret=${encodeURIComponent(WECOM_OPS_SECRET)}`,
    ).then((r) => r.json()).catch((e) => ({ errmsg: e.message }));
    wecomToken = t?.access_token ?? '';
    if (!wecomToken) wecomStatus = `api_error:gettoken ${t?.errcode ?? '-'} ${t?.errmsg ?? ''}`;
  }
  if (!wecomToken) return null;
  const d = await fetch(
    `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${wecomToken}&userid=${encodeURIComponent(name)}`,
  ).then((r) => r.json()).catch((e) => ({ errcode: -1, errmsg: e.message }));
  if (d?.errcode === 0) return String(d.userid);
  // 60111/46004 = 企微无此成员（遗留拼写）→ 返回 null（是「遗留号」的正解，不是错误）
  if (d?.errcode === 60111 || d?.errcode === 46004) return null;
  wecomStatus = `api_error:user/get ${d?.errcode ?? '-'} ${d?.errmsg ?? ''}`;
  return null;
}

// ---- 分组：同 lower(name) 多账号 ----
const byLower = new Map();
for (const u of users) {
  const k = String(u.name).toLowerCase();
  if (!byLower.has(k)) byLower.set(k, []);
  byLower.get(k).push(u.name);
}
const dupKeys = [...byLower.entries()].filter(([, v]) => v.length > 1).map(([k]) => k).sort();

const setOf = (m, n) => [...(m.get(n) ?? [])].sort();
const plan = [];   // 待迁移：{ kind:'role'|'group', name, from, to }

console.log(`\n===== Casdoor 大小写重复账号巡检（org=${CASDOOR_ORG}）${APPLY ? ' [APPLY]' : ' [DRY-RUN]'} =====`);
console.log(`用户 ${users.length} · 角色 ${roles.length} · 分组 ${groups.length} · 重复键 ${dupKeys.length}`);
if (wecomStatus === 'no_creds') {
  console.log('⚠️  未提供 WECOM_CORP_ID / WECOM_OPS_SECRET → 无法判定「企微当前账号」，只报不改');
}

let mustFix = 0;
let unknown = 0;
let applyFail = null; // --apply 的失败数（null = 未跑 --apply）

for (const key of dupKeys) {
  const names = byLower.get(key).sort();
  // 企微当前拼写：逐个问，命中者即 canonical
  const canonical = (await wecomCanonical(names[0])) ?? null;
  const legacy = names.filter((n) => n !== canonical);
  const known = canonical !== null && names.includes(canonical);

  const legacyRoles = [...new Set(legacy.flatMap((n) => setOf(rolesOf, n)))];
  const legacyGroups = [...new Set(legacy.flatMap((n) => setOf(groupsOf, n)))];
  const canonRoles = canonical ? setOf(rolesOf, canonical) : [];
  const canonGroups = canonical ? setOf(groupsOf, canonical) : [];

  // 缺口 = 遗留号持有、当前号没有的绑定（登录时读不到 → fail-close）
  const missRoles = legacyRoles.filter((x) => !canonRoles.includes(x));
  const missGroups = legacyGroups.filter((x) => !canonGroups.includes(x));
  // 缺口判定（对应登录 claims fail-close 的两道闸：reachable 非空 / groups 非空）
  //   角色：遗留号持有、当前号缺失 → 必迁（角色是人工授予，必须跟着人走）
  //   分组：仅当当前号「一个组都没有」才算缺口（groups 闸为空 → 拒登录）→ 用遗留组兜底迁入；
  //        当前号已有组则不算缺口——遗留号上多出来的组是过期归属（如 yangwei 的「总经办」），
  //        归属由薄同步 actionSyncGroups 按当前部门维护（只增不删），脚本不越权补过期组。
  const roleGap = known && missRoles.length > 0;
  const groupGap = known && canonGroups.length === 0 && missGroups.length > 0;
  const gap = roleGap || groupGap;

  console.log(`\n### ${key}${known ? '' : '  ⚠️ 当前账号未判定'}`);
  for (const n of names) {
    const tag = known ? (n === canonical ? '【企微当前】' : '【遗留】    ') : '           ';
    console.log(`   ${tag} ${n.padEnd(14)} roles=${(setOf(rolesOf, n).join(',') || '∅').padEnd(24)} groups=${setOf(groupsOf, n).join(',') || '∅'}`);
  }
  if (gap) {
    mustFix++;
    console.log('   ❌ 缺口：遗留号持有而当前号缺失 → 登录会被 fail-close 拒');
    if (roleGap) console.log(`      角色：${missRoles.join(',')}`);
    if (groupGap) console.log(`      分组：${missGroups.join(',')}（当前号无任何组，兜底迁入）`);
    if (!groupGap && missGroups.length > 0) {
      console.log(`      ℹ️  遗留号另有分组未迁（当前号已有组，不需要）：${missGroups.join(',')}`);
    }
  } else if (!known) {
    unknown++;
  } else {
    console.log('   ✅ 无缺口');
  }

  if (APPLY && known) {
    if (roleGap) for (const r of missRoles) plan.push({ kind: 'role', name: r, from: legacy, to: canonical });
    if (groupGap) for (const g of missGroups) plan.push({ kind: 'group', name: g, from: legacy, to: canonical });
  }
}

// ---- 迁移（--apply）----
if (APPLY) {
  if (wecomStatus !== 'ok') {
    console.error(`\n❌ --apply 需企微账号解析可用（当前：${wecomStatus}）——否则无法判定迁移目标`);
    process.exit(2);
  }
  if (plan.length === 0) {
    console.log('\n✅ 无待迁移绑定');
  } else {
    console.log(`\n===== 迁移 ${plan.length} 项绑定 =====`);
    let ok = 0, fail = 0;
    for (const p of plan) {
      try {
        if (p.kind === 'role') {
          // 角色：update-role 整对象读回 → 摘遗留号、补当前号 → 写回 → 回读校验
          const id = `${CASDOOR_ORG}/${p.name}`;
          const cur = unwrap(await casdoor(token, `/api/get-role?id=${encodeURIComponent(id)}`));
          const obj = Array.isArray(cur) ? cur[0] : cur;
          if (!obj) throw new Error('角色读回为空');
          const before = (obj.users ?? []).map(bare);
          const next = before.filter((n) => !p.from.includes(n));
          if (!next.includes(p.to)) next.push(p.to);
          await casdoor(token, `/api/update-role?id=${encodeURIComponent(id)}`, 'POST', {
            ...obj,
            users: next.map((n) => `${CASDOOR_ORG}/${n}`),
          });
          const after = unwrap(await casdoor(token, `/api/get-role?id=${encodeURIComponent(id)}`));
          const got = ((Array.isArray(after) ? after[0] : after)?.users ?? []).map(bare);
          const good = got.includes(p.to) && !p.from.some((n) => got.includes(n));
          console.log(`${good ? '✅' : '⚠️'} role ${p.name}: 目标 ${p.to} ${got.includes(p.to) ? '已加入' : '未加入'} · 遗留 [${p.from.join(',')}] ${p.from.some((n) => got.includes(n)) ? '仍在' : '已摘除'}`);
          good ? ok++ : fail++;
        } else {
          // 分组：写 **user.groups**（update-user 合并对象），与仓库薄同步 syncUserGroups 同口径。
          // 不走 update-group：本 Casdoor fork 的 update-group 回 "Affected" 但读回不变（实测）。
          const uid = `${CASDOOR_ORG}/${p.to}`;
          const u = (await casdoor(token, `/api/get-user?id=${encodeURIComponent(uid)}`)).data;
          if (!u) throw new Error(`用户 ${p.to} 读回为空`);
          // 密码护栏：update-user 不哈希密码、且丢弃 passwordType（改密码必挂）——
          // 带密码的账号不碰（本场景都是企微 SSO 用户，password 为空）
          if (u.password && u.passwordType) {
            console.log(`⚠️ group ${p.name}: ${p.to} 带密码（passwordType=${u.passwordType}），跳过以免 update-user 洗掉密码`);
            fail++;
            continue;
          }
          const before = (u.groups ?? []).map(String);
          const want = `${CASDOOR_ORG}/${p.name}`;
          const next = [...new Set([...before, want])];
          await casdoor(token, `/api/update-user?id=${encodeURIComponent(uid)}`, 'POST', { ...u, groups: next });
          const u2 = (await casdoor(token, `/api/get-user?id=${encodeURIComponent(uid)}`)).data;
          const got = (u2?.groups ?? []).map(String);
          const good = got.includes(want);
          console.log(`${good ? '✅' : '⚠️'} group ${p.name}: ${p.to} ${good ? '已加入' : '未加入'}（groups ${before.length}→${got.length}）`);
          good ? ok++ : fail++;
        }
      } catch (e) {
        console.log(`⚠️ ${p.kind} ${p.name}: ${e.message}`);
        fail++;
      }
    }
    console.log(`\n迁移完成：成功 ${ok} · 失败 ${fail}`);
    applyFail = fail;
    if (fail > 0) process.exit(1);
  }
}

// ---- 结论 ----
console.log('\n===== 结论 =====');
const inconclusive = wecomStatus !== 'ok';
if (inconclusive) {
  console.log(`⚠️  结论不可判定（企微账号解析未成功：${wecomStatus}）`);
  if (wecomStatus.startsWith('api_error') && wecomStatus.includes('60020')) {
    console.log('    → 出口 IP 不在企微「企业可信IP」白名单；请在实例机上跑本脚本。');
  }
} else if (mustFix === 0) {
  console.log('✅ 无「遗留号持有绑定」的缺口');
} else if (applyFail === 0) {
  console.log('✅ 迁移完成：上方缺口已消除（如需复核可再跑一次 dry-run）');
} else {
  console.log(`❌ ${mustFix} 对账号存在绑定缺口${APPLY ? '（见上方迁移结果）' : '，用 --apply 迁移'}`);
}
if (unknown > 0) console.log(`ℹ️  ${unknown} 对未判定当前账号`);
if (mustFix > 0 && !APPLY) console.log('\n提示：遗留账号在绑定清空后已无法被登录命中，停用/删除请在 Casdoor 管理台人工执行。');
process.exit(inconclusive ? 2 : (applyFail === 0 ? 0 : (mustFix > 0 && !APPLY ? 1 : 0)));
