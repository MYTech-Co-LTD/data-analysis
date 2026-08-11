// web/lib/report-center/boards/supply-chain/manifest.ts
// 供应链出库板块（P4）：serverGet = 现有 getSupplyChainOutbound 迁入（逻辑不动，含 closed 快照分支）；
// Desktop/Mobile 复用 components/report-center/supply-chain-outbound-table（不重写）。
import type { BoardManifest } from "@/lib/contracts";
import {
  getSupplyChainOutbound,
  type SupplyChainOutboundRow,
} from "@/lib/report-center/supply-chain-outbound";
import { SupplyChainBoard } from "./desktop";

export const supplyChainBoard: BoardManifest<SupplyChainOutboundRow> = {
  id: "supply-chain",
  serverGet: (targetId, opts) => getSupplyChainOutbound(targetId, opts.closed),
  Desktop: SupplyChainBoard,
  menuLabel: "供应链出库",
};
