// web/lib/report-center/boards/wholesale/manifest.ts
// 外部批发日报板块（P4）：serverGet = 现有 getWholesaleDaily 迁入（逻辑不动，含 closed 快照分支）；
// Desktop/Mobile 复用 components/report-center/wholesale-daily-table（不重写）。
import type { BoardManifest } from "@/lib/contracts";
import {
  getWholesaleDaily,
  type WholesaleDailyRow,
} from "@/lib/report-center/wholesale-daily";
import { WholesaleBoard } from "./desktop";

export const wholesaleBoard: BoardManifest<WholesaleDailyRow> = {
  id: "wholesale",
  serverGet: (targetId, opts) => getWholesaleDaily(targetId, opts.closed),
  Desktop: WholesaleBoard,
  menuLabel: "外部批发",
};
