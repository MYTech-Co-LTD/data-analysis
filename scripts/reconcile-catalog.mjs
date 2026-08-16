#!/usr/bin/env node
// scripts/reconcile-catalog.mjs —— W1 Task5（W1 退出判据）：permission.resources vs catalog 对账。
//
// 对账基准（F11）：Casdoor Permission.resources = 真授权语义；resource 注册表（get-resources）只是
//   可勾选面——本脚本对 permission.resources 并集 vs 本地 catalog 分类，与注册表对账（Task 4 差集只插）区分。
// catalog 单真相（H12）：集合从 web/lib/capability-catalog.ts + capability-catalog.generated.ts 同源
//   文件正则抽取（两文件一致性由 Task 2 scan 的 GHA 门禁保证），不在本脚本另立副本；
//   DEPRECATED 清单解析复用 scan-capabilities.deprecatedKeysFromCatalog（H14 同源）。
// 分级沿用 08-15 C/E/M：E-unknown-key / E-deprecated-key（红）；C-sync-failed（Task 4 resource-sync
//   failed 通道喂入，红——能力注册失败 = 永不可配，L2 不许静默）；M-unreferenced（提示，不算红）。
// 通配持有者审计（M2/redteam）：废弃 key 被命名空间通配覆盖时按 key 直接审计显示不出 → E-deprecated
//   的 holders 显式展开通配持有者；通配持有者另行单列 wildcardHolders（风险面，Task 6 辅助页消费）。
// 对账范围 = data-analysis:* 命名空间 + 全局 '*'；push:* 等引擎裸 key（H4 禁 data-analysis: 前缀）
//   不入 catalog 也不算红，仅计入通配审计。
// 退出码：0=无红 / 1=C/E 级红非空（门禁语义）/ 2=运行失败（env 缺失、Casdoor 不可达等 fail-loud）。
//
// 用法：
//   node scripts/reconcile-catalog.mjs [--sync-failures <file|->]
//     stdout = 对账 JSON（Task 6 辅助页 holders 列消费）；stderr = 人读摘要。
//     --sync-failures 可选喂入 Task 4 同步失败通道（JSON 数组 [{key,error}]；'-' = 显式 stdin 管道，
//     不加该参数绝不读 stdin——ssh/cron 下 stdin 恒开不 EOF，盲读会挂死）。

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deprecatedKeysFromCatalog } from './scan-capabilities.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// catalog key 命名空间（与 Task1 命名空间测试同源）：view / view-group / field / brand / category / admin
const KEY_NS_RE = /^data-analysis:(view|view-group|field|brand|category|admin)(:|$)/;
const shortWild = (w) => w.replace(/^data-analysis:/, '');   // holder 展示短格式：view:*（测试基线钉死）
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// ---- 纯函数（对账分类核心，node:test 直测） ----

export function classifyDiff({ permissions, catalog, deprecated, syncFailures = [] }) {
  const red = [], minor = [], perUser = [], wildcardHolders = [];

  // permission.resources 引用并集：key → holders[]（持有全局 '*' 的 permission，其持有形态标注 (*)）
  const referenced = new Map();
  for (const p of permissions) {
    for (const r of p.resources ?? []) {
      if (!referenced.has(r)) referenced.set(r, []);
      referenced.get(r).push((p.resources ?? []).includes('*') ? `${p.name}(*)` : p.name);
    }
  }

  // C-sync-failed：Task 4 resource-sync failed 通道喂入（红）
  for (const f of syncFailures)
    red.push({ kind: 'C-sync-failed', key: f.key, holders: ['resource-sync'], error: f.error });

  // E-unknown-key：范围内非通配 key 不在 catalog（反向发现，校验器同源逻辑）
  for (const [key, holders] of referenced) {
    if (key === '*' || key.endsWith(':*')) continue;    // 通配本身合法（残余声明见 spec §5.7）
    if (!KEY_NS_RE.test(key)) continue;                 // 范围外命名空间（push:* 引擎裸 key，H4）
    if (deprecated.has(key)) continue;                  // 废弃 key 统一走下方 M2 通道（合并三源持有者）
    if (!catalog.has(key)) red.push({ kind: 'E-unknown-key', key, holders });
  }

  // E-deprecated-key（M2 核心）：废弃 key 仍被授权语义覆盖 = 直接引用 ∪ 命名空间通配覆盖 ∪ 全局 '*'
  //   → 红。holders 显式含通配持有者（按 key 直接审计显示不出通配覆盖——redteam M2 风险面）；
  //   无任何持有者的废弃 key 不算红（驱逐判据之一：对账红区清零）。
  for (const key of deprecated) {
    const holders = new Set();
    for (const p of permissions) {
      const rs = p.resources ?? [];
      if (rs.includes('*')) { holders.add(`${p.name}(*)`); continue; }
      if (rs.includes(key)) holders.add(p.name);
      for (const w of rs)
        if (w !== '*' && w.endsWith(':*') && key.startsWith(w.slice(0, -1)))   // view:* 覆盖 view:xxx
          holders.add(`${p.name}(${shortWild(w)})`);
    }
    if (holders.size) red.push({ kind: 'E-deprecated-key', key, holders: [...holders] });
  }
  red.sort(byKey);

  // M-unreferenced：catalog 内 key 未被任何 permission 直接引用（可配但没人配——提示，不算红）
  for (const key of catalog) if (!referenced.has(key)) minor.push({ kind: 'M-unreferenced', key });
  minor.sort((a, b) => (a.key < b.key ? -1 : 1));

  // per-user 汇总（对象数粒度会掩盖个别用户缺失）：catalog 内持有 keys + 越界项 offending（catalog 外/废弃）
  for (const p of permissions) {
    const rs = p.resources ?? [];
    perUser.push({
      user: p.name,
      keys: rs.filter((r) => catalog.has(r)),
      offending: rs
        .filter((r) => KEY_NS_RE.test(r) && r !== '*' && !r.endsWith(':*') && !catalog.has(r))
        .map((r) => ({ key: r, kind: deprecated.has(r) ? 'E-deprecated-key' : 'E-unknown-key' })),
    });
  }

  // 通配持有者审计（M2 风险面单列）：全局 '*' 与命名空间 ':*'（含 push:*——引擎裸 key 同为通配风险）
  for (const p of permissions)
    for (const w of (p.resources ?? []).filter((r) => r === '*' || r.endsWith(':*')))
      wildcardHolders.push({ user: p.name, wildcard: w });

  return { red, minor, perUser, wildcardHolders };
}

// ---- CLI：真实拉取 Casdoor permissions ----

const CASDOOR_API = process.env.CASDOOR_API_URL || process.env.CASDOOR_API || 'https://sso.shanhaiyiguo.com';
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || '';
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || '';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';

// catalog 集合抽取（H12：同源文件正则，非第二副本）：
//   generated 行 + MANUAL/OVERRIDES/VIEW_GROUPS 字面量并入一集；DEPRECATED 块（scan 同源解析）剔除。
export function catalogKeysFromSources(catalogSrc, genSrc) {
  const deprecated = deprecatedKeysFromCatalog(catalogSrc);
  const keys = new Set(
    [...`${catalogSrc}${genSrc}`.matchAll(/'(data-analysis:[^']+)'/g)]
      .map((m) => m[1])
      .filter((k) => KEY_NS_RE.test(k)),
  );
  for (const d of deprecated) keys.delete(d);
  return { catalog: keys, deprecated };
}

// client_credentials（与 web/lib/sync/casdoor-client.ts / scripts/backfill-perms.mjs 同款模式；
// DW1 勘误 #4：真实通道失败不抛 {ok:false}——脚本独立 fetch 在此归一为 throw，统一走 Fatal exit 2）
async function getAccessToken() {
  const resp = await fetch(`${CASDOOR_API}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: CASDOOR_CLIENT_ID,
      client_secret: CASDOOR_CLIENT_SECRET, scope: 'openid',
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
  const list = Array.isArray(j) ? j : (j?.data ?? []);
  // H3 怪癖防御：resource 注册表名恒带 "/" 前缀——permission.resources 同源勾选面，比对前统一剥离
  return list.map((p) => ({ ...p, resources: (p.resources ?? []).map((r) => String(r).replace(/^\//, '')) }));
}

function readSyncFailures(argv) {
  const i = argv.indexOf('--sync-failures');
  if (i === -1) return [];
  const src = argv[i + 1];
  if (src === undefined) throw new Error('--sync-failures 需 <file|-> 参数');
  const raw = src === '-' ? readFileSync(0, 'utf8') : readFileSync(src, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('--sync-failures 须为 JSON 数组 [{key,error}]');
  return parsed;
}

async function main() {
  const syncFailures = readSyncFailures(process.argv.slice(2));

  const { catalog, deprecated } = catalogKeysFromSources(
    readFileSync(join(ROOT, 'web/lib/capability-catalog.ts'), 'utf8'),
    readFileSync(join(ROOT, 'web/lib/capability-catalog.generated.ts'), 'utf8'),
  );
  console.error(`[reconcile-catalog] catalog ${catalog.size} keys（deprecated ${deprecated.size}）@ ${CASDOOR_API} owner=${CASDOOR_ORG}`);

  if (!CASDOOR_CLIENT_ID || !CASDOOR_CLIENT_SECRET) {
    throw new Error('缺 CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET（client_credentials 同款 env）');
  }
  const token = await getAccessToken();
  const permissions = await fetchPermissions(token);

  const d = classifyDiff({ permissions, catalog, deprecated, syncFailures });
  const eCount = d.red.filter((r) => r.kind.startsWith('E-')).length;
  const cCount = d.red.filter((r) => r.kind.startsWith('C-')).length;
  console.error(`[reconcile-catalog] permissions ${permissions.length} × catalog ${catalog.size} → 红 ${d.red.length}（E ${eCount} / C ${cCount}）/ 提示 ${d.minor.length} / 通配持有者 ${d.wildcardHolders.length}`);
  for (const r of d.red) console.error(`  [${r.kind}] ${r.key} ← ${r.holders.join(', ')}`);
  console.log(JSON.stringify({
    summary: {
      permissions: permissions.length, catalogKeys: catalog.size, deprecatedKeys: deprecated.size,
      red: d.red.length, minor: d.minor.length, wildcardHolders: d.wildcardHolders.length,
    },
    ...d,
  }, null, 2));
  if (d.red.length) process.exit(1);
}

// 入口守卫：被 import（node:test）时不跑 CLI，只有直接执行才进 main
const isEntry = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isEntry) {
  main().catch((e) => { console.error('[reconcile-catalog] Fatal:', e.message); process.exit(2); });
}
