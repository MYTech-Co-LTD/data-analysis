// scripts/scan-capabilities.mjs
// 能力点自动发现（spec §5.1 ②，W1 Task2）：语义层 view-configs + app 页面路由 → catalog 草案。
//
// 双断言：
//   新增——源新增视图/路由 → 扫描多出该 key，check 模式报 drift（exit 1），--write 落进 generated；
//   删除——源下线 → key 不再被发现，check 模式报 removed drift（exit 1），--write 后从 generated 消失。
//
// H14（删除走人工废弃清单）：capability-catalog.ts 已引用的 key（OVERRIDES/VIEW_GROUPS/MANUAL 里的
//   `data-analysis:view:*` 字面量 = 保护键）即使源不可再发现也不静默丢失；key 的正式移除只能由人工
//   把它加进 catalog 的 DEPRECATED 清单（本脚本读取并在生成时过滤）。CLI 无参 = 校验门禁
//   （generated ≠ 期望产物 → exit 1）；--write 重写 generated。
//
// 命名空间守卫：产出的 key 必须符合 `data-analysis:view:<slug>`（与 Task1 catalog 命名空间测试同源），
//   违者 exit 1 fail-loud（不静默截断/改写）。
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW_CONFIGS_PATH = join(ROOT, 'services/semantic-generator/src/view-configs.ts');
const APP_DIR = join(ROOT, 'web/app');
const CATALOG_PATH = join(ROOT, 'web/lib/capability-catalog.ts');
const GEN_PATH = join(ROOT, 'web/lib/capability-catalog.generated.ts');

// 与 Task1 命名空间测试同源：data-analysis:view:<slug>（slug 允许字母/数字/_/中文/-，非空）
const VIEW_KEY_RE = /^data-analysis:view:[A-Za-z0-9_一-龥-]+$/;

const viewKey = (slug) => `data-analysis:view:${slug}`;
const slugOf = (key) => key.slice('data-analysis:view:'.length);
const canon = (key) => ({ key, group: '看板', label: slugOf(key), source: 'auto' });
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); // 码位序，跨环境确定性

export function scanSources({ viewNames, routeDirs } = {}) {
  const views = viewNames ?? viewConfigNames(); // view-configs.ts 的 view_name 注册名
  const routes = routeDirs ?? appRouteDirs();   // web/app 顶层页面路由段（admin/api 等除外）
  const out = new Map();
  for (const v of views) out.set(viewKey(v), canon(viewKey(v)));
  for (const r of routes) out.set(viewKey(r), canon(viewKey(r)));
  return [...out.values()].sort(byKey);
}

// view-configs.ts 真实注册形态（2026-08-16 实测）：具名导出 + view_name 属性——
//   export const brandMetricView: ViewConfig = { view_name: 'report_brand_metric_gen', ... }
// 提取前剥离块/行注释——注释里出现的 view_name 字面量不算注册（删除演练实测踩过：注释盲会漏报 drift）。
export function viewConfigNames() {
  const raw = readFileSync(VIEW_CONFIGS_PATH, 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  return [...new Set([...src.matchAll(/view_name:\s*'([^']+)'/g)].map((m) => m[1]))];
}

// web/app 路由发现：顶层目录即页面路由段（reports/mobile/...）。
// 排除：admin（走门禁不入 catalog，plan Task2 测试钉死）、api、auth/login/help/debug/clear-cache
// （工具/认证页非能力视图）、`_` 前缀（私有布局段）、`[` 动态段。
// 兼容路由组形态（plan 假设的 (app)/(pc)，现仓库无）：括号目录下钻一层取子目录。
const ROUTE_EXCLUDE = new Set(['admin', 'api', 'auth', 'login', 'help', 'debug', 'clear-cache', 'reports']);
export function appRouteDirs() {
  if (!existsSync(APP_DIR)) return [];
  const out = [];
  const take = (name) =>
    !name.startsWith('_') && !name.startsWith('[') && !ROUTE_EXCLUDE.has(name);
  for (const d of readdirSync(APP_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (/^\(.*\)$/.test(d.name)) { // 路由组：下钻一层
      for (const c of readdirSync(join(APP_DIR, d.name), { withFileTypes: true }))
        if (c.isDirectory() && take(c.name)) out.push(c.name);
      continue;
    }
    if (take(d.name)) out.push(d.name);
  }
  return [...new Set(out)].sort();
}

// 命名空间守卫：返回不合 view:<slug> 命名空间的 key（CLI 见非空即 exit 1）
export function invalidKeys(entries) {
  return entries.map((e) => e.key).filter((k) => !VIEW_KEY_RE.test(k));
}

export function renderGenerated(entries, deprecated = new Set()) {
  const rows = entries
    .filter((e) => !deprecated.has(e.key))
    .map((e) => {
      const label = e.label ?? slugOf(e.key);
      const group = e.group ?? '看板';
      return `  { key: '${e.key}', group: '${group}', label: '${label}', source: 'auto' },`;
    })
    .join('\n');
  return `// web/lib/capability-catalog.generated.ts
// ⚠️ 自动生成（scripts/scan-capabilities.mjs）；进 git，重跑 diff 即测试。禁止手改。
// 保留键说明：catalog.ts 已引用的 view key（保护键）与 DEPRECATED 过滤由 scan 维护（H14）。
export const GENERATED_CATALOG: readonly {
  key: string; group: string; label: string; source: 'auto';
}[] = Object.freeze([
${rows}
]);
`;
}

// 解析 generated 文件行（canonical 形态）；解析失败的行直接无视——check 模式按字节比对兜底报 drift
export function parseGenerated(src) {
  if (!src) return [];
  const rows = [...src.matchAll(
    /\{\s*key:\s*'([^']+)',\s*group:\s*'([^']*)',\s*label:\s*'([^']*)',\s*source:\s*'auto'/g,
  )];
  return rows.map((m) => ({ key: m[1], group: m[2], label: m[3], source: 'auto' }));
}

// 保护键：catalog.ts 里被引用的 view:* 字面量（OVERRIDES/VIEW_GROUPS members/MANUAL）。
// 这些 key 牵着 Task1 的「VIEW_GROUPS 成员 ∈ CATALOG」不变量与 Casdoor 勾选面，源不可发现也不许静默丢。
// DEPRECATED 数组块剔除——废弃键走过滤通道，不进保护集。
export function protectedViewKeys(catalogSrc) {
  const src = catalogSrc.replace(/const DEPRECATED[^=]*=\s*\[[^\]]*\]/, '');
  return new Set([...src.matchAll(/'(data-analysis:view:[^']+)'/g)].map((m) => m[1]));
}

// DEPRECATED 清单（H14 删除正道）：只读抽取 catalog.ts 的 const DEPRECATED 数组
export function deprecatedKeysFromCatalog(catalogSrc) {
  const m = catalogSrc.match(/const DEPRECATED[^=]*=\s*\[([^\]]*)\]/);
  if (!m) return new Set();
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

// 合并决策（双断言核心）：
//   next = discovered ∪ (current ∩ protectedKeys) − deprecated
//   非保护且不再被发现 → 移除（removed 报出）；保护键 → 保留；新发现 → added 报出。
export function planNext({ discovered, current, protectedKeys = new Set(), deprecated = new Set() }) {
  const wanted = new Map(discovered.map((e) => [e.key, e]));
  for (const e of current)
    if (protectedKeys.has(e.key) && !deprecated.has(e.key) && !wanted.has(e.key))
      wanted.set(e.key, e);
  for (const k of deprecated) wanted.delete(k);
  const next = [...wanted.values()].sort(byKey);
  const curKeys = new Set(current.map((e) => e.key));
  const nextKeys = new Set(next.map((e) => e.key));
  return {
    next,
    added: next.filter((e) => !curKeys.has(e.key)).map((e) => e.key),
    removed: current.filter((e) => !nextKeys.has(e.key)).map((e) => e.key),
  };
}

// ---- CLI（直接执行时才跑；import 供测试无副作用）----
function main() {
  const catalogSrc = readFileSync(CATALOG_PATH, 'utf8');
  const discovered = scanSources();
  const current = parseGenerated(existsSync(GEN_PATH) ? readFileSync(GEN_PATH, 'utf8') : '');
  const bad = invalidKeys([...discovered, ...current]);
  if (bad.length) {
    console.error(`[scan] 命名空间违规（须 ${VIEW_KEY_RE}）: ${bad.join(', ')}`);
    process.exit(1);
  }
  const { next, added, removed } = planNext({
    discovered,
    current,
    protectedKeys: protectedViewKeys(catalogSrc),
    deprecated: deprecatedKeysFromCatalog(catalogSrc),
  });
  const out = renderGenerated(next, deprecatedKeysFromCatalog(catalogSrc));

  if (process.argv.includes('--write')) {
    writeFileSync(GEN_PATH, out);
    console.log(`[scan] generated 已重写（+${added.length}/-${removed.length}）`);
    if (added.length) console.log(`[scan] 新增: ${added.join(', ')}`);
    if (removed.length) console.log(`[scan] 移除: ${removed.join(', ')}`);
    return;
  }
  const cur = existsSync(GEN_PATH) ? readFileSync(GEN_PATH, 'utf8') : '';
  if (cur !== out) {
    if (added.length) console.error(`[scan] 新增未落 generated: ${added.join(', ')}`);
    if (removed.length) console.error(`[scan] 已下线未清出 generated: ${removed.join(', ')}`);
    console.error('[scan] generated 与扫描结果不一致——运行 node scripts/scan-capabilities.mjs --write 后提交');
    process.exit(1);
  }
  console.log('[scan] 一致');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
