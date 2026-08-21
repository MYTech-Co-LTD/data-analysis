// 一次性：收集报表横幅渲染所需全部字符（Task 8 Step 1）。
// 读 banner-report.ts / banner-report-resolve.ts 源码字面量 + 生产 dim 有限值（品牌/战区），
// 去重排序写 web/scripts/push-banner-charset.txt（仓库保留，未来加字复用）。
// 用法：cd web && node scripts/push-banner-charset-collect.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 1) 从源码提取字符串字面量（单引号/双引号/反引号模板）内的全部字符
const files = [
  join(root, 'lib/push/banner-report.ts'),
  join(root, 'lib/push/banner-report-resolve.ts'),
];

function literalChars(src) {
  const out = new Set();
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '`' || c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) {
        // 模板字面量里的 ${...} 表达式字符不入集（值是运行时数据，非字面量）
        if (quote === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1, k = j + 2;
          while (k < src.length && depth > 0) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}') depth--;
            k++;
          }
          j = k;
          continue;
        }
        if (src[j] === '\\') { j += 2; continue; }
        out.add(src[j]);
        j++;
      }
      i = Math.max(j + 1, i + 1);
    } else {
      i++;
    }
  }
  return out;
}

const set = new Set();
for (const f of files) {
  for (const ch of literalChars(readFileSync(f, 'utf8'))) set.add(ch);
}

// 2) 生产 dim 有限值（2026-08-21 SSH 查 prod：dim_brand enabled + dim_war_zone is_assessed）
//    品牌名来自 dim_brand.brand_name；合计行 brand_name=NULL 回退 system_book_code='合计'。
//    战区名 = dim_branch.first_level_region（= dim_war_zone.war_zone 匹配键，全称）。
for (const s of [
  '熊喵鲜生', '品品甜', '合计',
  '东部战区', '南部战区', '西部战区', '中部战区',
]) for (const ch of s) set.add(ch);

// 3) 显式兜底：ASCII 数字/标点/符号（值格式化 ¥1,234,567 / 60.6% / 2026-08-21 / '--'）
for (const ch of '0123456789¥%.,-+():/ ') set.add(ch);
// 4) 日期表头的语义集合：data.date 是运行时值（现按 spec 渲 2026-08-21 纯 ISO 横线），
//    年月日汉字 + 横线预留——若未来改渲「2026年8月21日」格式，字体子集/引用表须含这些字。
for (const ch of '年月日横线') set.add(ch);

// 过滤控制字符（模板字面量首尾换行是源码排版产物，非显示字符；SVG 文本空白折叠不渲染）
for (const c of [...set]) if (/[\x00-\x1F\x7F]/.test(c)) set.delete(c);

const chars = [...set].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
writeFileSync(join(root, 'scripts/push-banner-charset.txt'), chars.join(''), 'utf8');
console.log('charset written:', chars.length, 'unique chars');
console.log('content:', chars.join(''));
