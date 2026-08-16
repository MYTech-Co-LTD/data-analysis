#!/usr/bin/env node
/**
 * shadow-diff.mjs — S4 shadow 干跑 diff 脚本（plan Task 10）
 *
 * 比对新链路 shadow 渲染产物 vs 旧通道实际内容，输出差异报告。
 * 差异分类：
 *   - scope_diff: 权限/范围差异导致的值不同（预期，不影响验收）
 *   - content_diff: 非 scope 差异（新链路 bug，须修复）
 *
 * 用法：
 *   node scripts/shadow-diff.mjs --txn <txnId> [--old <old-content.json>] [--url <postgrest_url>] [--key <api_key>]
 *
 * 输入格式（旧通道内容 JSON）：
 *   {
 *     "groups": [
 *       {
 *         "signature": "<group_signature>",
 *         "members": ["wecom_id1", ...],
 *         "variables": { "var_code1": "rendered_value1", ... }
 *       }
 *     ]
 *   }
 *
 * 输出：JSON diff report（stdout）+ 人类可读摘要（stderr）
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 参数解析 ----

function parseArgs(argv) {
  const args = { txn: null, old: null, url: null, key: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--txn' && argv[i + 1]) args.txn = argv[++i];
    else if (argv[i] === '--old' && argv[i + 1]) args.old = argv[++i];
    else if (argv[i] === '--url' && argv[i + 1]) args.url = argv[++i];
    else if (argv[i] === '--key' && argv[i + 1]) args.key = argv[++i];
    else if (argv[i] === '--help') {
      console.error(`Usage: shadow-diff.mjs --txn <txnId> [--old <old-content.json>] [--url <postgrest_url>] [--key <api_key>]
  --txn   Shadow txn_id to read from push_trigger_payloads (required)
  --old   Path to old channel content JSON for comparison (optional; without it, just dumps shadow payloads)
  --url   PostgREST URL (default: $POSTGREST_URL or http://postgrest:3000)
  --key   PostgREST API key (default: $INSFORGE_API_KEY)`);
      process.exit(0);
    }
  }
  if (!args.txn) {
    console.error('Error: --txn <txnId> is required. Run shadow-diff.mjs --help for usage.');
    process.exit(1);
  }
  return args;
}

// ---- PostgREST 读取 ----

async function fetchShadowPayloads(txnId, postgrestUrl, apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
  const url = `${postgrestUrl}/push_trigger_payloads?txn_id=eq.${encodeURIComponent(txnId)}&order=group_sig`;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`PostgREST read failed: ${r.status} ${detail}`);
  }
  const rows = await r.json();
  return rows
    .filter((row) => row.payload?.mode === 'shadow')
    .map((row) => {
      const { mode: _mode, ...rest } = row.payload;
      return rest;
    });
}

// ---- 归一化：剥除权限差异导致的变异 ----

/**
 * 归一化变量值，去除 scope 差异导致的表面不同。
 * - 数字格式统一（千分位/百分比/单位差异 → 原始数值）
 * - 脱敏占位符统一（"(无权限查看)" / "***" → "[REDACTED]"）
 * - 空白/换行统一
 */
function normalizeValue(val) {
  if (val == null) return null;
  let s = String(val).trim();
  // 脱敏占位符统一
  if (/^(无权限查看|\(无权限查看\)|\*{3,}|REDACTED|\[REDACTED\])$/i.test(s)) return '[REDACTED]';
  // 千分位逗号去除
  s = s.replace(/,/g, '');
  // 百分号保留数值部分
  s = s.replace(/(\d+(?:\.\d+)?)\s*%$/, '$1%');
  // 单位统一（元/万/亿 → 保留数字+单位标记）
  s = s.replace(/\s*(元|万元|亿元|万|亿)\s*$/, ' $1');
  return s;
}

/**
 * 归一化变量集合：key 集合 + 归一化后的 value。
 * 返回 Map<varCode, normalizedValue>。
 */
function normalizeVariables(vars) {
  if (!vars || typeof vars !== 'object') return new Map();
  const result = new Map();
  for (const [k, v] of Object.entries(vars)) {
    result.set(k, normalizeValue(v));
  }
  return result;
}

// ---- diff 核心 ----

/**
 * 比对 shadow 组 vs old 组，输出 diff 列表。
 * @param {object} shadowGroup - { signature, members, variables }
 * @param {object} oldGroup    - { signature, members, variables }
 * @returns {{ scopeDiffs: Diff[], contentDiffs: Diff[] }}
 */
function diffGroups(shadowGroup, oldGroup) {
  const scopeDiffs = [];
  const contentDiffs = [];

  const shadowVars = normalizeVariables(shadowGroup.variables);
  const oldVars = normalizeVariables(oldGroup.variables);

  // 收集所有 var codes
  const allVarCodes = new Set([...shadowVars.keys(), ...oldVars.keys()]);

  for (const code of allVarCodes) {
    const sv = shadowVars.get(code);
    const ov = oldVars.get(code);

    if (sv === ov) continue; // 归一化后一致 → 无差异

    const diff = {
      type: 'value_mismatch',
      varCode: code,
      shadow: shadowGroup.variables?.[code] ?? undefined,
      old: oldGroup.variables?.[code] ?? undefined,
      normalizedShadow: sv,
      normalizedOld: ov,
    };

    // 判断是否为 scope 差异：
    //   1. 一方脱敏、另一方有值 → 权限差异（scope_diff）
    //   2. 数值不同但同量级 → 可能是数据时间窗差异（scope_diff）
    //   3. 其他 → content_diff（新链路 bug）
    if (sv === '[REDACTED]' || ov === '[REDACTED]') {
      // 一方脱敏：权限差异
      scopeDiffs.push({ ...diff, reason: 'permission_mask' });
    } else if (sv != null && ov != null && isNumericPair(sv, ov)) {
      // 两者都是数值：检查是否在容差范围内（数据更新时间差导致的微小差异）
      const sn = parseNumeric(sv);
      const on = parseNumeric(ov);
      const relDiff = Math.abs(sn - on) / Math.max(Math.abs(sn), Math.abs(on), 1);
      if (relDiff < 0.01) {
        // <1% 差异视为数据更新时间窗差异
        scopeDiffs.push({ ...diff, reason: 'data_freshness', relativeDiff: relDiff });
      } else {
        contentDiffs.push({ ...diff, reason: 'significant_value_diff', relativeDiff: relDiff });
      }
    } else {
      // 结构性差异：不同变量集合 / 不同文本格式 → content_diff
      contentDiffs.push({ ...diff, reason: 'format_or_presence_diff' });
    }
  }

  // 成员集合差异（scope_diff：不同权限 → 不同成员集）
  const shadowMembers = new Set(shadowGroup.members ?? []);
  const oldMembers = new Set(oldGroup.members ?? []);
  const addedMembers = [...shadowMembers].filter((m) => !oldMembers.has(m));
  const removedMembers = [...oldMembers].filter((m) => !shadowMembers.has(m));
  if (addedMembers.length || removedMembers.length) {
    scopeDiffs.push({
      type: 'member_diff',
      shadowCount: shadowMembers.size,
      oldCount: oldMembers.size,
      added: addedMembers.slice(0, 5),
      removed: removedMembers.slice(0, 5),
      reason: 'scope_membership',
    });
  }

  return { scopeDiffs, contentDiffs };
}

function isNumericPair(a, b) {
  return /^-?[\d,.]+(?:\s*(?:元|万|亿|%))?$/.test(a) && /^-?[\d,.]+(?:\s*(?:元|万|亿|%))?$/.test(b);
}

function parseNumeric(s) {
  return parseFloat(s.replace(/,/g, '').replace(/\s*(元|万|亿|%)/g, '')) || 0;
}

// ---- 匹配策略 ----

/**
 * 按 signature 匹配 shadow 组 vs old 组。
 * 若 signature 不一致（新旧分组逻辑不同），降级按 members 交集最大的进行模糊匹配。
 */
function matchGroups(shadowGroups, oldGroups) {
  const pairs = [];
  const unmatchedShadow = [];
  const unmatchedOld = [...oldGroups];

  for (const sg of shadowGroups) {
    // 精确匹配：signature 一致
    const exactIdx = unmatchedOld.findIndex((og) => og.signature === sg.signature);
    if (exactIdx >= 0) {
      pairs.push({ shadow: sg, old: unmatchedOld[exactIdx], matchType: 'exact_signature' });
      unmatchedOld.splice(exactIdx, 1);
      continue;
    }
    // 模糊匹配：members 交集最大
    let bestIdx = -1;
    let bestOverlap = 0;
    const sMembers = new Set(sg.members ?? []);
    for (let i = 0; i < unmatchedOld.length; i++) {
      const overlap = (unmatchedOld[i].members ?? []).filter((m) => sMembers.has(m)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestOverlap > 0) {
      pairs.push({ shadow: sg, old: unmatchedOld[bestIdx], matchType: 'fuzzy_members' });
      unmatchedOld.splice(bestIdx, 1);
    } else {
      unmatchedShadow.push(sg);
    }
  }

  return { pairs, unmatchedShadow, unmatchedOld: unmatchedOld };
}

// ---- 主流程 ----

async function main() {
  const args = parseArgs(process.argv);
  const postgrestUrl = args.url || process.env.POSTGREST_URL || 'http://postgrest:3000';
  const apiKey = args.key || process.env.INSFORGE_API_KEY;
  if (!apiKey) {
    console.error('Error: INSFORGE_API_KEY not set (use --key or env)');
    process.exit(1);
  }

  // 1. 读 shadow 渲染产物
  console.error(`[shadow-diff] Reading shadow payloads for txn=${args.txn} ...`);
  const shadowGroups = await fetchShadowPayloads(args.txn, postgrestUrl, apiKey);
  if (!shadowGroups.length) {
    console.error(`[shadow-diff] No shadow payloads found for txn=${args.txn}`);
    process.exit(1);
  }
  console.error(`[shadow-diff] Found ${shadowGroups.length} shadow groups`);

  // 无 old 文件：仅 dump shadow 快照
  if (!args.old) {
    console.error('[shadow-diff] No --old file provided, dumping shadow snapshot only');
    const report = {
      txn: args.txn,
      shadowGroups: shadowGroups.length,
      groups: shadowGroups.map((g) => ({
        signature: g.signature,
        memberCount: (g.members ?? []).length,
        variables: g.variables,
      })),
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // 2. 读旧通道内容
  const oldContent = JSON.parse(readFileSync(resolve(args.old), 'utf-8'));
  const oldGroups = oldContent.groups ?? [];
  console.error(`[shadow-diff] Loaded ${oldGroups.length} old groups from ${args.old}`);

  // 3. 匹配 + diff
  const { pairs, unmatchedShadow, unmatchedOld } = matchGroups(shadowGroups, oldGroups);

  const allScopeDiffs = [];
  const allContentDiffs = [];

  for (const pair of pairs) {
    const { scopeDiffs, contentDiffs } = diffGroups(pair.shadow, pair.old);
    for (const d of scopeDiffs) allScopeDiffs.push({ ...d, groupSignature: pair.shadow.signature, matchType: pair.matchType });
    for (const d of contentDiffs) allContentDiffs.push({ ...d, groupSignature: pair.shadow.signature, matchType: pair.matchType });
  }

  // 未匹配组
  for (const g of unmatchedShadow) {
    allContentDiffs.push({
      type: 'group_only_in_shadow',
      groupSignature: g.signature,
      memberCount: (g.members ?? []).length,
      reason: 'new_group_no_old_match',
    });
  }
  for (const g of unmatchedOld) {
    allContentDiffs.push({
      type: 'group_only_in_old',
      groupSignature: g.signature,
      memberCount: (g.members ?? []).length,
      reason: 'old_group_no_shadow_match',
    });
  }

  // 4. 报告
  const report = {
    txn: args.txn,
    timestamp: new Date().toISOString(),
    summary: {
      shadowGroups: shadowGroups.length,
      oldGroups: oldGroups.length,
      matchedPairs: pairs.length,
      scopeDiffs: allScopeDiffs.length,
      contentDiffs: allContentDiffs.length,
      verdict: allContentDiffs.length === 0 ? 'PASS' : 'FAIL',
    },
    scopeDiffs: allScopeDiffs,
    contentDiffs: allContentDiffs,
    unmatchedShadow: unmatchedShadow.map((g) => ({ signature: g.signature, members: (g.members ?? []).length })),
    unmatchedOld: unmatchedOld.map((g) => ({ signature: g.signature, members: (g.members ?? []).length })),
  };

  // JSON report (stdout)
  console.log(JSON.stringify(report, null, 2));

  // Human-readable summary (stderr)
  console.error('\n=== Shadow Diff Report ===');
  console.error(`Txn: ${args.txn}`);
  console.error(`Shadow groups: ${shadowGroups.length} | Old groups: ${oldGroups.length}`);
  console.error(`Matched pairs: ${pairs.length}`);
  console.error(`Scope diffs (expected): ${allScopeDiffs.length}`);
  console.error(`Content diffs (bugs): ${allContentDiffs.length}`);
  console.error(`Verdict: ${report.summary.verdict}`);

  if (allContentDiffs.length > 0) {
    console.error('\n--- Content Diffs (require investigation) ---');
    for (const d of allContentDiffs.slice(0, 20)) {
      if (d.type === 'value_mismatch') {
        console.error(`  [${d.groupSignature}] ${d.varCode}: shadow="${d.shadow}" vs old="${d.old}" (${d.reason})`);
      } else if (d.type === 'group_only_in_shadow') {
        console.error(`  [NEW GROUP] ${d.groupSignature} (${d.memberCount} members)`);
      } else if (d.type === 'group_only_in_old') {
        console.error(`  [MISSING] ${d.groupSignature} (${d.memberCount} members in old, not in shadow)`);
      }
    }
    if (allContentDiffs.length > 20) {
      console.error(`  ... and ${allContentDiffs.length - 20} more`);
    }
  }

  process.exit(allContentDiffs.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[shadow-diff] Fatal:', e.message);
  process.exit(2);
});
