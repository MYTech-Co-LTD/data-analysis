// web/lib/report-center/boards/registry.ts
// 报告板块注册表（P4）：目标看板页（web/app/reports/targets/[id]/page.tsx）按此清单
// Promise.allSettled 并行取数 + 渲染 board.Desktop/Mobile。
// 宿主只依赖本注册表 + contracts——新板块 = 新目录（boards/<id>/）+ 此处追加 1 行；
// 板块之间禁止互相 import（§4.4 依赖方向铁律，eslint import/no-restricted-paths 已严执）。
//
// 渲染顺序 = 注册顺序（对齐旧 desktop/mobile 布局：KPI → 品牌 → 战区 → 商品TOP → 类别 →
// 供应链+批发并排；item-top 内部先销售后出库，共用日榜 day state）。
//
// 看板能力一致性（2026-08-17）：每个 board 必须在 capability-board.ts 单真相有对应能力
// （data-analysis:view-board:<id>），否则该看板无法被配置权限。加载时校验防漂移——
// 缺能力 = 抛错（宁可显式故障，不让「已收权」用户看到未受控看板）。
/* eslint-disable @typescript-eslint/no-explicit-any -- 注册表混入异构板块（各板块自身带 TRow 类型），宿主以 any 消费，P4 冻结后再逐步收紧 */
import type { BoardManifest } from "@/lib/contracts";
import { BOARD_CAPABILITY_BY_ID } from "@/lib/capability-board";
import { kpiBoard } from "./kpi/manifest";
import { brandBoard } from "./brand/manifest";
import { regionBoard } from "./region/manifest";
import { itemTopBoard } from "./item-top/manifest";
import { categoryBoard } from "./category/manifest";
import { supplyChainBoard } from "./supply-chain/manifest";
import { wholesaleBoard } from "./wholesale/manifest";

export const BOARDS: BoardManifest<any>[] = [
  kpiBoard,
  brandBoard,
  regionBoard,
  itemTopBoard,
  categoryBoard,
  supplyChainBoard,
  wholesaleBoard,
];

// 看板 ↔ 能力单真相一致性（防漂移）：每个注册 board.id 必须在 capability-board.ts 有定义。
// 模块加载即校验（server 构建期暴露；dev 热更时同样触发）。缺能力 → 抛错。
const boardIds = new Set(BOARDS.map((b) => b.id));
const missing = [...boardIds].filter((id) => !BOARD_CAPABILITY_BY_ID.has(id));
if (missing.length > 0) {
  throw new Error(
    `[capability-board] 看板未在 capability-board.ts 注册对应能力（data-analysis:view-board:<id>）：${missing.join(', ')}`,
  );
}
const extra = [...BOARD_CAPABILITY_BY_ID.keys()].filter((id) => !boardIds.has(id));
if (extra.length > 0) {
  console.warn(`[capability-board] 能力单真相含未注册看板（registry 缺失）：${extra.join(', ')}`);
}
