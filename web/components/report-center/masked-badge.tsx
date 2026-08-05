"use client";

// F2.3 — 脱敏列头角标：profit/margin 列头的小图标，让用户知道该列 NULL/「—」
// 是**权限脱敏**（can_see_cost=false）而非真实 0/亏损。
//
// 设计：slate 中性（对齐 DESIGN.md，与 PermissionBanner 同色系——本是「正常权限提示」，
// 区别于 PartialDegradeBanner 的 amber 警示）。lucide-react EyeOff 图标传达「隐藏/不可见」语义。
// DESIGN.md **禁 emoji**——故不用 🚫（brief 草稿的 emoji 替换为图标）。
// 不改 profit 渲染逻辑（Task 8 fmtProfit/fmtMargin 已对 null 返「—」）；此组件仅列头提示。
import { EyeOff } from "lucide-react";

export function MaskedBadge() {
  return (
    <span
      className="ml-1 inline-flex align-middle text-slate-400"
      title="该列已按权限脱敏（can_see_cost=false），显示为 —"
      aria-label="该列已按权限脱敏"
    >
      <EyeOff size={14} strokeWidth={1.5} />
    </span>
  );
}
