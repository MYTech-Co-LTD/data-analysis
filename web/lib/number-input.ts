// web/lib/number-input.ts
// 数字输入归一（2026-10-10 实测坑，issue #90）。
//
// 背景：`<input type="number">` 的行为在两个浏览器里不一致——
//   · Chrome/Edge：全角字符（中文输入法默认输出 １２３４５）被**直接拒收**，框里什么都不出现；
//   · Firefox：全角字符**照收进框里并显示**，但 `input.value` 返回**空串**（不是合法浮点数）。
// 于是上层 `Number(e.target.value) || 0` 在 Firefox 下把用户明明看得见的输入算成 0 ——
// 「输入框里显示着 11111，保存后变成 0」，且只在 Firefox 复现。
//
// 解法（本模块 + 调用侧）：
//   1) 数字输入框一律用 `type="text" inputMode="numeric"`（`value` 恒可读，不再有「显示值与
//      DOM value 不一致」这一整类问题；inputMode 保住移动端数字键盘）；
//   2) onChange 里先过本模块归一（全角→半角、去千分位逗号/空格、只留数字/小数点/负号），
//      再交给上层 `Number()`——保证「用户看到的 = 存进 state 的」。

// 全角数字 ０-９（U+FF10–U+FF19）→ 半角（减 0xFEE0）
const FULLWIDTH_DIGITS = /[\uFF10-\uFF19]/g;

// 其它常见全角符号 → 半角
const FULLWIDTH_MAP: Record<string, string> = {
  "．": ".", // 全角句点
  "－": "-", // 全角连字符/负号
  "，": ",", // 全角逗号
  "　": " ", // 全角空格
};

/**
 * 把「用户可能打出来的任意数字形态」归一成可被 `Number()` 正确解析的字符串。
 * - 全角 → 半角（中文输入法必踩）
 * - 去千分位逗号、空白
 * - 只保留数字 / 小数点 / 负号（其余字符丢弃——因为是受控输入，用户会立刻看到被丢弃的结果）
 * 空串原样返回（表示「未填」）。
 */
export function normalizeNumberInput(raw: string): string {
  if (!raw) return "";
  let s = raw.replace(FULLWIDTH_DIGITS, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  s = s.replace(/[．－，　]/g, (c) => FULLWIDTH_MAP[c] ?? c);
  s = s.replace(/[,\s]/g, "");
  s = s.replace(/[^\d.-]/g, "");
  return s;
}
