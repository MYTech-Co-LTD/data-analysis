// web/lib/capability-catalog.ts
// 能力点 catalog 单真相（spec §5.1，H12 纪律：唯一副本，function 只消费不复制）。
// 组成 = generated（scan 自动发现，scripts/scan-capabilities.mjs 产出）+ overrides（人工层）+ manual（手工清单）。
import { GENERATED_CATALOG } from './capability-catalog.generated';
import { BOARD_CAPABILITIES, KPI_CARD_CAPABILITIES } from './capability-board';

export interface CatalogEntry {
  key: string;            // data-analysis:view:reports / field:cost / brand:3120 / view-board:kpi / view-kpi:sale / ...
  group: string;          // 辅助页分组：看板 / 字段 / 品牌 / 品类 / 门禁
  label: string;          // 展示名/通俗名（唯一真相：驱动 Casdoor resource.name + KEY_TO_LABEL/LABEL_TO_KEY）
  description?: string;   // 一句话描述（能力页「描述」列）
  sensitive?: boolean;    // 敏感标记（field 类默认 true）
  source: 'auto' | 'manual';
}

// 人工覆盖层：只改展示属性与标记，不增删 key（增删走 view-configs/路由 + scan）
const OVERRIDES: Partial<Record<string, Partial<CatalogEntry>>> = {
  'data-analysis:view:reports':        { group: '看板', label: '经营总览' },
  // 2026-08-17 方案 C 退役：view:reports-items（零消费）——已移入 DEPRECATED，不再由 OVERRIDES 保护
  'data-analysis:view:reports-targets':{ group: '看板', label: '目标达成' },
  // 2026-08-17 方案 C 退役：view:wholesale-customers（零消费）——已移入 DEPRECATED，不再由 OVERRIDES 保护
  'data-analysis:field:cost':          { group: '字段', label: '成本可见', sensitive: true },
};

// 手工清单（scan 覆盖不到的：门禁/推送已排除——push:* 是引擎裸 key，不入 catalog）
const MANUAL: CatalogEntry[] = [
  { key: 'data-analysis:admin', group: '门禁', label: '管理台', source: 'manual' },
  // 授权组名自身也是 resource（spec §5.5：Casdoor 只见组名 resource 勾选）——scan 覆盖不到，入 manual
  // 2026-08-18 门禁拆分（用户裁决 A）：报表中心仅门禁（页面级），看板/KPI 卡能力单独配置
  { key: 'data-analysis:gate:reports-center', group: '门禁', label: '报表中心', source: 'manual' },
  { key: 'data-analysis:field:cost', group: '字段', label: '成本可见', sensitive: true, source: 'manual' },
  { key: 'data-analysis:brand:3120', group: '品牌', label: '熊喵鲜生', source: 'manual' },
  { key: 'data-analysis:brand:64188', group: '品牌', label: '品品甜', source: 'manual' },
  { key: 'data-analysis:category:水果', group: '品类', label: '水果', source: 'manual' },
  { key: 'data-analysis:category:标品', group: '品类', label: '标品', source: 'manual' },
  { key: 'data-analysis:category:耗材', group: '品类', label: '耗材', source: 'manual' },
  // 看板/KPI 能力（单真相在 capability-board.ts，此处只做 catalog 合并——H12：不复制定义）
  ...BOARD_CAPABILITIES.map((b) => ({
    key: b.key, group: '看板', label: b.name, description: b.description, source: 'manual' as const,
  })),
  ...KPI_CARD_CAPABILITIES.map((k) => ({
    key: k.key, group: '看板', label: k.name, description: k.description, source: 'manual' as const,
  })),
];

// 废弃清单（H14/redteam M2）：载体在 app 侧；驱逐判据 = 发布 ≥30 天 ∧ 审计无引用 ∧ 对账红区清零
// 2026-08-17 方案 C：统一视图/看板——退役 11 个零消费 view:* 死 key（报表授权由 view-board:* 覆盖）。
//   8 个 report_*_gen 由 scan 从 view-configs 自动发现 → 废弃清单过滤；
//   view:mobile 由 scan 从路由自动发现 → 废弃清单过滤；
//   view:reports-items / view:wholesale-customers 已从 OVERRIDES 摘除（不再保护）→ 废弃清单过滤。
const DEPRECATED: readonly string[] = [
  // 2026-08-18 门禁拆分退役：旧组名（展示名「看板|报表看板全组」）→ 由 gate:reports-center 替代
  'data-analysis:view-group:reports-all',
  // 退役：报表视图 → 由看板能力覆盖（view-board:<id>）
  'data-analysis:view:report_brand_metric_gen',
  'data-analysis:view:report_category_summary_gen',
  'data-analysis:view:report_item_breakdown_gen',
  'data-analysis:view:report_region_breakdown_gen',
  'data-analysis:view:report_supply_chain_outbound_gen',
  'data-analysis:view:report_wholesale_customer_gen',
  'data-analysis:view:report_wholesale_daily_customer_gen',
  'data-analysis:view:report_wholesale_daily_gen',
  // 退役：零消费页面视图
  'data-analysis:view:mobile',
  'data-analysis:view:reports-items',
  'data-analysis:view:wholesale-customers',
];

const merged: CatalogEntry[] = [...GENERATED_CATALOG, ...MANUAL].map((e) => ({
  ...e, ...OVERRIDES[e.key],
}));

// key 去重（generated 与 manual 撞 key 时 manual 优先——人工兜底）
const seen = new Set<string>();
const deduped: CatalogEntry[] = [];
for (const e of [...merged].reverse()) { if (!seen.has(e.key)) { seen.add(e.key); deduped.unshift(e); } }

// 通俗名唯一性断言（方案 C 全量）：label = Casdoor resource.name（主键）+ BY_NAME 反查键，
// 重名 = 模块加载即抛错（与 capability-board 2026-08-17 模式一致）。
{
  const seen = new Set<string>();
  for (const e of deduped) {
    if (!e.label) continue;
    if (seen.has(e.label)) {
      throw new Error(`[capability-catalog] 通俗名重复（破坏 Casdoor resource name 主键 + BY_NAME 反查）：${e.label}`);
    }
    seen.add(e.label);
  }
}

export const capabilityCatalog: readonly CatalogEntry[] = Object.freeze(deduped);
export const CATALOG_KEYS: ReadonlySet<string> = new Set(capabilityCatalog.map((e) => e.key));
export const DEPRECATED_KEYS: ReadonlySet<string> = new Set(DEPRECATED);

// 通俗名 ↔ key 双向映射（方案 C 全量归一查找表；看板/KPI 的 label 与 capability-board name 一致）
export const KEY_TO_LABEL: ReadonlyMap<string, string> = new Map(
  deduped.filter((e) => e.label).map((e) => [e.key, e.label]),
);
export const LABEL_TO_KEY: ReadonlyMap<string, string> = new Map(
  deduped.filter((e) => e.label).map((e) => [e.label, e.key]),
);

// ============ Casdoor 展示名（2026-08-17：功能点显示加「组|」前缀）============
// Casdoor 管理端下拉框显示 resource.name，管理员无法区分功能点归属组 → 统一显示 `组|label`
// （无 label 的 scan 自动发现兜底 `组|映射名`）。半角 `|`（生产实测 add-resource 接受）。
// 设计取舍：保留 KEY_TO_LABEL/LABEL_TO_KEY（前端能力页纯 label 展示），新增本双映射供 Casdoor 侧。
export const DISPLAY_SEP = '|' as const;

// key → `组|label`（无 label 时 `组|映射名`，与 resource-sync enc 同规则：`:`→`_`）
const displayEnc = (key: string): string => key.replace(/:/g, '_');
export function displayNameFor(key: string): string {
  const e = capabilityCatalog.find((x) => x.key === key);
  if (!e) return `${DISPLAY_SEP}${displayEnc(key)}`;   // 防御：未知名 → `|映射名`（消费侧反查原样透传兜底）
  return e.label ? `${e.group}${DISPLAY_SEP}${e.label}` : `${e.group}${DISPLAY_SEP}${displayEnc(key)}`;
}

export const KEY_TO_DISPLAY_NAME: ReadonlyMap<string, string> = new Map(
  deduped.map((e) => [e.key, displayNameFor(e.key)]),
);
export const DISPLAY_NAME_TO_KEY: ReadonlyMap<string, string> = new Map(
  [...KEY_TO_DISPLAY_NAME].map(([k, d]) => [d, k]),
);

// 展示名唯一性断言（Casdoor resource.name 主键 + 反查不可歧义；与 label 断言同模式）
{
  const seen = new Set<string>();
  for (const d of KEY_TO_DISPLAY_NAME.values()) {
    if (seen.has(d)) {
      throw new Error(`[capability-catalog] Casdoor 展示名重复（破坏 resource.name 主键 + DISPLAY_NAME_TO_KEY 反查）：${d}`);
    }
    seen.add(d);
  }
}

// 授权组（spec §5.5）：映射在 catalog（app 侧），不复制进 Casdoor policy
export const VIEW_GROUPS = Object.freeze({
  // 2026-08-18 门禁拆分：原 view-group:reports-all（看板全组，名不符实）改为纯页面门禁组。
  // 语义：仅可进入报表中心/目标页；看板可见性由 view-board:*（hasBoardPerm fail-close）单独裁决。
  'data-analysis:gate:reports-center': {
    label: '报表中心',
    members: [
      'data-analysis:view:reports', 'data-analysis:view:reports-targets',
    ],
  },
} as const);
