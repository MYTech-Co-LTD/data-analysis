"use client";

// F2.3 — 共享 client hook：取当前用户 can_see_cost 权限（来自 /api/me）。
//
// 用途：脱敏列头角标（MaskedBadge）需要知道当前用户是否被脱敏（can_see_cost=false）。
// 抽 hook + **module 级 promise 缓存**避免报表中心 5+ 组件各自 fetch /api/me。
// 首次调用发起 fetch，后续组件共享同一 promise（同源 PermissionBanner Task 9，但彼此独立缓存——
// PermissionBanner 关心 branch_nums，本 hook 关心 can_see_cost，字段不同不强行合并）。
//
// 失败语义（保守不标）：
//   - fetch 失败 / 401 / JSON 异常 → 返 true（=不脱敏）
//   - 理由：最坏情况是漏标（用户不知道自己被脱敏，但 RLS/cost masking 仍在数据层生效，安全无损）；
//     反之返 false 会把「已脱敏」角标误显给有权用户，造成困惑。前者损害小，选 true。
//   - 与 PermissionBanner 同思路（保守不显）。
//
// 初值：true（不脱敏）——避免首屏闪烁角标给有权用户。fetch 完成后更新；最坏只漏标几毫秒。
import { useEffect, useState } from "react";

// module 级缓存：同 page load 多组件共享。null = 未发起；非 null = 进行中/已完成。
let _promise: Promise<boolean> | null = null;

function loadCanSeeCost(): Promise<boolean> {
  if (!_promise) {
    _promise = fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.can_see_cost === true)
      .catch(() => true); // 失败保守不标（见上文失败语义）
  }
  return _promise;
}

/**
 * Returns whether the current user has `can_see_cost=true` (i.e., profit/margin
 * columns are NOT masked for them). Modules invoking this share a single
 * cached fetch per page load.
 *
 * Initial value is `true` (not masked) to avoid flashing the masked badge to
 * permitted users on first paint; the hook updates after `/api/me` resolves.
 */
export function useCanSeeCost(): boolean {
  const [canSeeCost, setCanSeeCost] = useState(true);
  useEffect(() => {
    let cancelled = false;
    loadCanSeeCost().then((v) => {
      if (!cancelled) setCanSeeCost(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return canSeeCost;
}

/** Test-only: reset the module-level cache between tests. */
export function __resetCanSeeCostCacheForTest(): void {
  _promise = null;
}
