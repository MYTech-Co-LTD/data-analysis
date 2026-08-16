#!/usr/bin/env node
// scripts/u2_switch.mjs —— Task 13: U2 登录输入源切换脚本
// 门禁检查 + 翻开关 + 冒烟测试（非周五非月初运行）
// 用法：node scripts/u2_switch.mjs [--dry-run]
// 环境变量：PGHOST / PGUSER / PGDATABASE / PGPASSWORD（或标准 PG 环境变量）
//   服务器部署时：docker compose exec -T postgres psql ... 或直接 PGPASSWORD=... node scripts/u2_switch.mjs
//
// 步骤：
//   1. 门禁：shadow diff 最近 24h 无 diff
//   2. 门禁：连续 ≥7 天无 diff
//   3. 门禁：outbox 清空（如有 perm_outbox 表）
//   4. UPDATE system_flags SET value='casdoor' WHERE key='perms_input'
//   5. 冒烟：get_user_perms 抽样 + system_flags 验证 + role_codes 覆盖率
//   6. 输出切换报告

import { execSync } from "child_process";

const DRY_RUN = process.argv.includes("--dry-run");

// psql 执行封装（复用标准 PG 环境变量）
function psql(sql) {
  try {
    const result = execSync(`psql -v ON_ERROR_STOP=1 -t -A -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      env: { ...process.env },
      timeout: 30000,
    });
    return result.trim();
  } catch (e) {
    throw new Error(`psql failed: ${e.message}\nstdout: ${e.stdout}\nstderr: ${e.stderr}`);
  }
}

// 多行 SQL（用 stdin）
function psqlStdin(sql) {
  try {
    const result = execSync(`psql -v ON_ERROR_STOP=1 -t -A`, {
      input: sql,
      encoding: "utf-8",
      env: { ...process.env },
      timeout: 30000,
    });
    return result.trim();
  } catch (e) {
    throw new Error(`psql stdin failed: ${e.message}\nstdout: ${e.stdout}\nstderr: ${e.stderr}`);
  }
}

// 操作安全：非周五非月初
function assertSafeDate() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 5=Fri
  const date = now.getDate();
  if (day === 5) {
    console.error("ERROR: 禁止周五切换（周末无人值守，回滚窗口不足）");
    process.exit(1);
  }
  if (date <= 2) {
    console.error("ERROR: 禁止月初 1-2 号切换（月初业务高峰期）");
    process.exit(1);
  }
  console.log(`OK: 日期安全检查通过：${now.toISOString().slice(0, 10)} (weekday=${day}, date=${date})`);
}

async function main() {
  assertSafeDate();
  let exitCode = 0;

  // Step 1: 门禁——最近 24h shadow diff
  console.log("\n=== Step 1: Shadow diff 门禁（24h） ===");
  const diffCount24h = psql(`
    SELECT count(*) FROM perm_shadow_log
    WHERE checked_at > NOW() - INTERVAL '1 day'
      AND array_length(diff_keys, 1) > 0
  `);
  if (Number(diffCount24h) > 0) {
    const samples = psql(`
      SELECT wecom_id || ': ' || array_to_string(diff_keys, ',')
      FROM perm_shadow_log
      WHERE checked_at > NOW() - INTERVAL '1 day'
        AND array_length(diff_keys, 1) > 0
      ORDER BY checked_at DESC LIMIT 5
    `);
    console.error(`FAIL: 最近 24h 有 ${diffCount24h} 用户存在 diff:`);
    console.error(samples);
    exitCode = 1;
  } else {
    console.log("OK: 最近 24h 无 diff 用户");
  }

  // Step 2: 门禁——连续 ≥7 天无 diff
  console.log("\n=== Step 2: 连续 7 天无 diff 检查 ===");
  const cleanDays = psql(`
    SELECT count(*) FROM (
      SELECT date_trunc('day', checked_at) AS day
      FROM perm_shadow_log
      WHERE checked_at > NOW() - INTERVAL '7 days'
      GROUP BY 1
      HAVING count(*) FILTER (WHERE array_length(diff_keys, 1) > 0) = 0
    ) sub
  `);
  if (Number(cleanDays) < 7) {
    console.error(`FAIL: 连续无 diff 仅 ${cleanDays}/7 天，不足 7 天`);
    exitCode = 1;
  } else {
    console.log(`OK: 连续 ${cleanDays} 天无 diff`);
  }

  // Step 3: 门禁——outbox 清空
  console.log("\n=== Step 3: Outbox 清空检查 ===");
  try {
    const outboxPending = psql(`SELECT count(*) FROM perm_outbox WHERE status = 'pending'`);
    if (Number(outboxPending) > 0) {
      console.error(`FAIL: perm_outbox 有 ${outboxPending} 条 pending`);
      exitCode = 1;
    } else {
      console.log("OK: perm_outbox 无 pending");
    }
  } catch {
    console.log("SKIP: perm_outbox 表不存在");
  }

  if (exitCode !== 0) {
    console.error("\nFAIL: 门禁未通过，中止切换");
    process.exit(1);
  }

  // Step 4: 翻开关
  console.log("\n=== Step 4: 切换 perms_input -> casdoor ===");
  const beforeVal = psql(`SELECT value FROM system_flags WHERE key = 'perms_input'`);
  console.log(`当前值: ${beforeVal || "N/A"}`);
  if (beforeVal === "casdoor") {
    console.log("SKIP: 已经是 casdoor 模式，无需切换");
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log("DRY RUN: 跳过实际 UPDATE");
  } else {
    psql(`UPDATE system_flags SET value = 'casdoor' WHERE key = 'perms_input'`);
    const afterVal = psql(`SELECT value FROM system_flags WHERE key = 'perms_input'`);
    console.log(`OK: 已切换: perms_input = ${afterVal}`);
  }

  // Step 5: 冒烟测试
  console.log("\n=== Step 5: 冒烟测试 ===");
  let smokeOk = true;

  // 5a: get_user_perms 抽样
  const sampleUsers = psqlStdin(`
    SELECT wecom_id FROM org_users WHERE is_active LIMIT 3
  `).split("\n").filter(Boolean);

  for (const uid of sampleUsers) {
    try {
      const permResult = psql(`SELECT get_user_perms('${uid}')::text`);
      if (!permResult || permResult === "null" || permResult === "") {
        console.error(`   FAIL ${uid}: get_user_perms 返回 null`);
        smokeOk = false;
      } else {
        // 简单解析 role_code
        const roleCodeMatch = permResult.match(/"role_code":\s*"([^"]*?)"/);
        const rc = roleCodeMatch ? roleCodeMatch[1] : "null";
        console.log(`   OK ${uid}: role_code=${rc}`);
      }
    } catch (e) {
      console.error(`   FAIL ${uid}: ${e.message}`);
      smokeOk = false;
    }
  }

  // 5b: system_flags 验证
  const flagCheck = psql(`SELECT value FROM system_flags WHERE key = 'perms_input'`);
  if (flagCheck !== "casdoor" && !DRY_RUN) {
    console.error(`   FAIL: system_flags 读取异常: ${flagCheck}`);
    smokeOk = false;
  } else {
    console.log(`   OK: system_flags = ${flagCheck}`);
  }

  // 5c: role_codes 覆盖率
  const rcStats = psql(`
    SELECT
      count(*) FILTER (WHERE role_codes IS NOT NULL AND array_length(role_codes, 1) > 0) || '/' ||
      count(*) || ' (' ||
      round(100.0 * count(*) FILTER (WHERE role_codes IS NOT NULL AND array_length(role_codes, 1) > 0) / greatest(count(*), 1), 0) || '%)'
    FROM org_users WHERE is_active
  `);
  console.log(`   STAT: role_codes 覆盖率: ${rcStats}`);

  if (!smokeOk) {
    console.error("\nFAIL: 冒烟测试失败");
    if (!DRY_RUN) {
      console.log("回滚...");
      psql(`UPDATE system_flags SET value = 'legacy' WHERE key = 'perms_input'`);
      console.log("OK: 已回滚至 legacy");
    }
    process.exit(1);
  }

  console.log("\nOK: 冒烟测试全部通过");

  // Step 6: 报告
  console.log("\n========== 切换报告 ==========");
  console.log(`时间: ${new Date().toISOString()}`);
  console.log(`模式: ${DRY_RUN ? "DRY RUN" : "实际切换"}`);
  console.log(`perms_input: ${beforeVal} -> casdoor`);
  console.log(`冒烟用户: ${sampleUsers.length}`);
  console.log(`role_codes 覆盖: ${rcStats}`);
  console.log("==============================");
  console.log("\n回滚命令:");
  console.log("  psql -c \"UPDATE system_flags SET value = 'legacy' WHERE key = 'perms_input'\"");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
