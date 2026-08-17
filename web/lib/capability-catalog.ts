// web/lib/capability-catalog.ts
// 能力点 catalog 单真相（spec §5.1，H12 纪律：唯一副本，function 只消费不复制）。
// 组成 = generated（scan 自动发现，scripts/scan-capabilities.mjs 产出）+ overrides（人工层）+ manual（手工清单）。
import { GENERATED_CATALOG } from './capability-catalog.generated';
import { BOARD_CAPABILITIES, KPI_CARD_CAPABILITIES } from './capability-board';

export interface CatalogEntry {
  key: string;            // data-analysis:view:reports / field:cost / brand:3120 / view-board:kpi / view-kpi:sale / ...
  group: string;          // 辅助页分组：看板 / 字段 / 品牌 / 品类 / 门禁
  label: string;          // 展示名（人工 override 可改）
  name?: string;          // 通俗命名（看板/KPI 能力等；能力页「通俗命名」列）
  description?: string;   // 一句话描述（能力页「描述」列）
  sensitive?: boolean;    // 敏感标记（field 类默认 true）
  source: 'auto' | 'manual';
}

// 人工覆盖层：只改展示属性与标记，不增删 key（增删走 view-configs/路由 + scan）
const OVERRIDES: Partial<Record<string, Partial<CatalogEntry>>> = {
  'data-analysis:view:reports':        { group: '看板', label: '经营总览' },
  'data-analysis:view:reports-items':  { group: '看板', label: '商品下钻' },
  'data-analysis:view:reports-targets':{ group: '看板', label: '目标达成' },
  'data-analysis:view:wholesale-customers': { group: '看板', label: '批发客户下钻' },
  'data-analysis:field:cost':          { group: '字段', label: '成本可见', sensitive: true },
};

// 手工清单（scan 覆盖不到的：门禁/推送已排除——push:* 是引擎裸 key，不入 catalog）
const MANUAL: CatalogEntry[] = [
  { key: 'data-analysis:admin', group: '门禁', label: '管理台', source: 'manual' },
  // 授权组名自身也是 resource（spec §5.5：Casdoor 只见组名 resource 勾选）——scan 覆盖不到，入 manual
  { key: 'data-analysis:view-group:reports-all', group: '看板', label: '报表看板全组', source: 'manual' },
  { key: 'data-analysis:field:cost', group: '字段', label: '成本可见', sensitive: true, source: 'manual' },
  { key: 'data-analysis:brand:3120', group: '品牌', label: '熊喵鲜生', source: 'manual' },
  { key: 'data-analysis:brand:64188', group: '品牌', label: '品品甜', source: 'manual' },
  { key: 'data-analysis:category:水果', group: '品类', label: '水果', source: 'manual' },
  { key: 'data-analysis:category:标品', group: '品类', label: '标品', source: 'manual' },
  { key: 'data-analysis:category:耗材', group: '品类', label: '耗材', source: 'manual' },
  // 看板/KPI 能力（单真相在 capability-board.ts，此处只做 catalog 合并——H12：不复制定义）
  ...BOARD_CAPABILITIES.map((b) => ({
    key: b.key, group: '看板', label: b.name, name: b.name, description: b.description, source: 'manual' as const,
  })),
  ...KPI_CARD_CAPABILITIES.map((k) => ({
    key: k.key, group: '看板', label: k.name, name: k.name, description: k.description, source: 'manual' as const,
  })),
];

// 废弃清单（H14/redteam M2）：载体在 app 侧；驱逐判据 = 发布 ≥30 天 ∧ 审计无引用 ∧ 对账红区清零
const DEPRECATED: readonly string[] = [];

const merged: CatalogEntry[] = [...GENERATED_CATALOG, ...MANUAL].map((e) => ({
  ...e, ...OVERRIDES[e.key],
}));

// key 去重（generated 与 manual 撞 key 时 manual 优先——人工兜底）
const seen = new Set<string>();
const deduped: CatalogEntry[] = [];
for (const e of [...merged].reverse()) { if (!seen.has(e.key)) { seen.add(e.key); deduped.unshift(e); } }

export const capabilityCatalog: readonly CatalogEntry[] = Object.freeze(deduped);
export const CATALOG_KEYS: ReadonlySet<string> = new Set(capabilityCatalog.map((e) => e.key));
export const DEPRECATED_KEYS: ReadonlySet<string> = new Set(DEPRECATED);

// 授权组（spec §5.5）：映射在 catalog（app 侧），不复制进 Casdoor policy
export const VIEW_GROUPS = Object.freeze({
  'data-analysis:view-group:reports-all': {
    label: '报表看板全组',
    members: [
      'data-analysis:view:reports', 'data-analysis:view:reports-items',
      'data-analysis:view:reports-targets', 'data-analysis:view:wholesale-customers',
    ],
  },
} as const);
