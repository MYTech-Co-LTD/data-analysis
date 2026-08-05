'use client';

// F2.2 — RLS 裁剪横幅（PermissionBanner）
//
// 用途：店长等限门店用户看到的「合计/战区/品牌」行仅含有权门店（PostgREST RLS 裁剪），
// 易把裁剪后的合计误读为全量。本横幅在 fetch /api/me 判定为限门店时显示提示。
//
// 判定显示（保守，宁可不显示）：
//   - branch_nums 是非空数组 且 不是 ['*']  → 显示
//   - '*' / 空数组 / 非数组 / fetch 失败 / 401  → 不显示
//
// 设计：client component（useEffect fetch）；page.tsx（RSC）直接渲染——client 组件可嵌 RSC。
// 颜色：slate 中性（对齐 DESIGN.md）——本者是「正常权限提示」，区别于 PartialDegradeBanner
// 的 amber（后者是「错误降级」）。
import { useEffect, useState } from 'react';

export function PermissionBanner() {
  const [masked, setMasked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        const bn = d.branch_nums;
        setMasked(
          Array.isArray(bn) &&
            bn.length > 0 &&
            !(bn.length === 1 && bn[0] === '*'),
        );
      })
      .catch(() => {
        // fetch/JSON 失败：保守不显示（不阻断渲染）
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!masked) return null;
  return (
    <div className="mb-3 rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-xs text-slate-600">
      ℹ️ 数据已按你的门店权限裁剪——「合计/战区/品牌」行仅含有权门店，非全量
    </div>
  );
}
