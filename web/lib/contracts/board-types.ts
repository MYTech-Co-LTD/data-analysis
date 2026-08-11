// web/lib/contracts/board-types.ts
// Board 插件契约（spec 2026-08-11-modular-plugin-design §4.3；P4 冻结）。
// 仅类型、无实现——P4 起由 web/lib/report-center/boards/* 各板块插件实现，
// 宿主（report-center 目标看板页）经 web/lib/report-center/boards/registry.ts 注册表分发。
//
// 依赖方向（§4.4）：contracts 是叶子包。GetterResult 是 report-center 全部 getter 共用的
// 返回契约（纯类型 + 工厂，无业务查询逻辑），此处 type-only 引用，不构成对业务模块的运行时依赖。
import type { ComponentType } from "react";
import type { GetterResult } from "@/lib/report-center/types";

/** BoardCtx：宿主注入 serverGet 的上下文——插件禁止自行建 client / 读取参数之外的秘密。 */
export interface BoardCtx {
  /** 已定格目标：各模块从 target_snapshot_breakdowns 读 close_target 冻结快照（视图不再算 closed 目标） */
  closed?: boolean;
  /** 未来扩展（设备/权限/品牌等） */
  [key: string]: unknown;
}

/** BoardProps：宿主渲染 board.Desktop/Mobile 时注入的 props（F1.3：透传 GetterResult，组件级 status='error' 显示模块失败占位）。 */
export interface BoardProps<TRow> {
  /** serverGet 结果原样透传（不提前解包 .rows） */
  result: GetterResult<TRow>;
  /** 目标 total 行（name/start_date/end_date/status/...），板块组件自取所需字段 */
  target: {
    name: string;
    start_date: string;
    end_date: string;
    status: string;
    [key: string]: unknown;
  };
  targetId: number;
  /** 时间进度 0-1（按「达成率/时间进度」相对着色） */
  progress: number;
  /** 目标月份 1-12 */
  targetMonth: number;
  isMobile?: boolean;
}

/**
 * Board 插件（spec §4.3）。
 * 新板块 = 新目录（boards/<id>/）+ registry 追加 1 行；板块之间禁止互相 import（§4.4）。
 */
export interface BoardManifest<TRow> {
  id: string; // 全局唯一，注册表主键
  serverGet: (targetId: number, opts: BoardCtx) => Promise<GetterResult<TRow>>; // SSR 取数
  Desktop: ComponentType<BoardProps<TRow>>;
  Mobile?: ComponentType<BoardProps<TRow>>; // 缺省复用 Desktop 容器
  menuLabel?: string;
}
