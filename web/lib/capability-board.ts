// web/lib/capability-board.ts
// 看板/KPI 卡片能力单真相（纯数据，零依赖——不得 import report-center 业务模块，防 catalog 依赖倒灌）。
// 分层命名空间（与 capability-catalog 的 view:* 页面级权限区分，H12 单真相）：
//   data-analysis:view-board:<boardId>  —— 看板级能力（控制整个看板块显示/取数）
//   data-analysis:view-kpi:<metricCode> —— KPI 卡片级能力（控制单个指标卡；含 2 个派生比率卡）
// 新增看板/卡片 = 在对应数组加 1 行；消费方（registry/manifest/能力页/casdoor 配置）全部经此单真相派生。
// ⚠ 命名空间纪律：key 必须符合 data-analysis:(view-board|view-kpi):<slug>（capability-catalog.test 钉死）。

export interface BoardCapability {
  /** 全局唯一能力 key（data-analysis:view-board:<id>） */
  key: string;
  /** 对应 BOARDS registry 的 board id（注册表主键） */
  id: string;
  /** 通俗命名（能力页展示） */
  name: string;
  /** 一句话描述（能力页展示，说明这看板是干什么的） */
  description: string;
}

export interface KpiCardCapability {
  /** 全局唯一能力 key（data-analysis:view-kpi:<code>） */
  key: string;
  /** metric_code（sale/delivery/outbound_amt/outbound_profit）或派生比率卡 key（delivery_sale_ratio/outbound_margin） */
  code: string;
  /** 通俗命名 */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 派生比率卡（不落库，由 4 张金额卡分量相除）——权限语义与金额卡独立 */
  isRatio?: boolean;
}

// ============ 看板层（7 个，对应 BOARDS registry 顺序） ============
export const BOARD_CAPABILITIES: readonly BoardCapability[] = Object.freeze([
  {
    key: 'data-analysis:view-board:kpi',
    id: 'kpi',
    name: '指标概览',
    description: '目标达成核心 KPI 指标卡（零售/配送/出库金额及完成率）',
  },
  {
    key: 'data-analysis:view-board:brand',
    id: 'brand',
    name: '品牌×指标',
    description: '品牌维度指标下钻（熊喵鲜生/品品甜）',
  },
  {
    key: 'data-analysis:view-board:region',
    id: 'region',
    name: '门店战区',
    description: '战区/区域/门店三级下钻（数据按你的门店权限裁剪）',
  },
  {
    key: 'data-analysis:view-board:item-top',
    id: 'item-top',
    name: '商品 TOP',
    description: '商品维度 TOP 排行（销售/出库日榜）',
  },
  {
    key: 'data-analysis:view-board:category',
    id: 'category',
    name: '类别出库',
    description: '品类维度出库汇总（水果/标品/耗材）',
  },
  {
    key: 'data-analysis:view-board:supply-chain',
    id: 'supply-chain',
    name: '供应链出库',
    description: '供应链出库明细（配送/批发双源）',
  },
  {
    key: 'data-analysis:view-board:wholesale',
    id: 'wholesale',
    name: '外部批发',
    description: '外部批发客户明细',
  },
]);

// ============ KPI 卡片层（6 个：4 金额卡 + 2 派生比率卡） ============
export const KPI_CARD_CAPABILITIES: readonly KpiCardCapability[] = Object.freeze([
  {
    key: 'data-analysis:view-kpi:sale',
    code: 'sale',
    name: '门店零售',
    description: '门店零售金额目标完成率',
  },
  {
    key: 'data-analysis:view-kpi:delivery',
    code: 'delivery',
    name: '门店配送',
    description: '门店配送金额目标完成率',
  },
  {
    key: 'data-analysis:view-kpi:outbound_amt',
    code: 'outbound_amt',
    name: '供应链出库金额',
    description: '供应链出库目标完成率',
  },
  {
    key: 'data-analysis:view-kpi:outbound_profit',
    code: 'outbound_profit',
    name: '供应链毛利',
    description: '供应链出库毛利目标完成率',
  },
  {
    key: 'data-analysis:view-kpi:delivery_sale_ratio',
    code: 'delivery_sale_ratio',
    name: '总配销比',
    description: '配送金额 / 销售金额 比值（派生卡）',
    isRatio: true,
  },
  {
    key: 'data-analysis:view-kpi:outbound_margin',
    code: 'outbound_margin',
    name: '毛利率',
    description: '供应链出库毛利率（派生卡，成本可见时显示）',
    isRatio: true,
  },
]);

/** 能力 key → BoardCapability 查表（校验/能力页复用） */
export const BOARD_CAPABILITY_BY_KEY: ReadonlyMap<string, BoardCapability> = new Map(
  BOARD_CAPABILITIES.map((b) => [b.key, b]),
);
/** board id → BoardCapability 查表（看板页按 board 过滤） */
export const BOARD_CAPABILITY_BY_ID: ReadonlyMap<string, BoardCapability> = new Map(
  BOARD_CAPABILITIES.map((b) => [b.id, b]),
);
/** 能力 key → KpiCardCapability 查表 */
export const KPI_CARD_CAPABILITY_BY_KEY: ReadonlyMap<string, KpiCardCapability> = new Map(
  KPI_CARD_CAPABILITIES.map((k) => [k.key, k]),
);
/** metric_code / ratio key → KpiCardCapability 查表（KPI 卡片按 code 过滤） */
export const KPI_CARD_CAPABILITY_BY_CODE: ReadonlyMap<string, KpiCardCapability> = new Map(
  KPI_CARD_CAPABILITIES.map((k) => [k.code, k]),
);

// ============ 通俗名 → 能力（方案甲：Casdoor resource.name 用通俗名，管理员从下拉选中通俗名写进
// permission.resources → 消费侧按通俗名反查 key。BY_NAME 反向映射即归一查找表。兼容能力页展示） ============

/** 通俗名 → BoardCapability 反查（归一：Casdoor 下拉选中的通俗名 → 能力 key） */
export const BOARD_CAPABILITY_BY_NAME: ReadonlyMap<string, BoardCapability> = new Map(
  BOARD_CAPABILITIES.map((b) => [b.name, b]),
);
/** 通俗名 → KpiCardCapability 反查（归一：Casdoor 下拉选中的通俗名 → 能力 key） */
export const KPI_CARD_CAPABILITY_BY_NAME: ReadonlyMap<string, KpiCardCapability> = new Map(
  KPI_CARD_CAPABILITIES.map((k) => [k.name, k]),
);

// 通俗名唯一性断言（防重名破坏反查 / Casdoor resource name 主键）：重名 = 模块加载即抛错。
// 2026-08-17：看板「供应链出库」与 KPI 卡「供应链出库」曾重名 → KPI 卡改名「供应链出库金额」消歧。
{
  const all = [...BOARD_CAPABILITIES, ...KPI_CARD_CAPABILITIES];
  const seen = new Set<string>();
  for (const c of all) {
    if (seen.has(c.name)) {
      throw new Error(`[capability-board] 通俗名重复（破坏 Casdoor resource name 主键 + BY_NAME 反查）：${c.name}`);
    }
    seen.add(c.name);
  }
}
