#!/usr/bin/env node
/**
 * lint-generator.mjs -- 反自由发挥：生成器代码禁业务字面量
 *
 * 生成器（src/generators/*.ts）应只含 AST 翻译 + 结构 SQL，禁硬编码业务口径
 * （表名/品牌/战区/breakdown 等）。业务字面量须在 view-configs.ts 或 registry 声明。
 *
 * 用法：node scripts/lint-generator.mjs（CI 集成）。发现违规 exit 1。
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const genDir = join(__dirname, '..', 'services', 'semantic-generator', 'src', 'generators');

// 业务字面量黑名单（正则）。命中 = 违规（须挪 config/registry）
// 只抓「真口径字面量」：品牌硬编码、聚合表名硬编码、breakdown 硬编码。
// 不抓统一结构（dim_branch join 的 system_book_code/branch_num、is_assessed_war_zone、
// first_level_region）--那是门店键/考核战区铁律的统一实现，非指标口径。
const BANNED = [
  /'3120'|'64188'/,            // 品牌硬编码（须 source_filter 声明）
  /report_daily_\w+\s*(?:AS|FROM|JOIN)/i,  // 聚合表名硬编码（须 metric_sources.source_table）
  /breakdown_level\s*=\s*'(?:store|region_l2|war_zone)'/i,  // breakdown 硬编码（须 target_breakdown）
];

if (!existsSync(genDir)) {
  console.error(`lint-generator: 目录不存在 ${genDir}`);
  process.exit(1);
}

let fail = false;
for (const f of readdirSync(genDir).filter(f => f.endsWith('.ts'))) {
  const path = join(genDir, f);
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;  // 跳注释
    for (const re of BANNED) {
      if (re.test(line)) {
        console.error(`${path}:${i + 1}: 业务字面量 \`${re.source}\` 须在 config/registry 声明，禁生成器硬编码`);
        console.error(`  > ${line.trim()}`);
        fail = true;
        break;
      }
    }
  });
}

if (fail) {
  console.error('\n❌ lint-generator: 生成器含业务字面量（自由发挥风险）。挪到 view-configs/registry。');
  process.exit(1);
}
console.log('✅ lint-generator: 生成器零业务字面量');
