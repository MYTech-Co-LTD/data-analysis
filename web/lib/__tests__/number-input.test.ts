// web/lib/__tests__/number-input.test.ts
// issue #90：Firefox 下 type=number 收全角数字但 value 为空 → 保存后变 0。
import { describe, expect, it } from "vitest";

import { normalizeNumberInput } from "../number-input";

describe("normalizeNumberInput", () => {
  it("全角数字 → 半角（中文输入法必踩，Firefox 下 value 会是空串）", () => {
    expect(normalizeNumberInput("１２３４５")).toBe("12345");
    expect(Number(normalizeNumberInput("１２３４５"))).toBe(12345);
  });

  it("混合全角/半角", () => {
    expect(normalizeNumberInput("１２3４5")).toBe("12345");
  });

  it("去千分位逗号与空白", () => {
    expect(normalizeNumberInput("1,234,567")).toBe("1234567");
    expect(normalizeNumberInput(" 1 234 ")).toBe("1234");
    expect(normalizeNumberInput("1，234")).toBe("1234"); // 全角逗号
  });

  it("保留小数点与负号", () => {
    expect(normalizeNumberInput("1234.56")).toBe("1234.56");
    expect(normalizeNumberInput("-500")).toBe("-500");
    expect(normalizeNumberInput("１２３４．５６")).toBe("1234.56"); // 全角句点
    expect(normalizeNumberInput("－500")).toBe("-500"); // 全角负号
  });

  it("丢弃非数字字符（受控输入，用户立刻看到结果）", () => {
    expect(normalizeNumberInput("12a3")).toBe("123");
    expect(normalizeNumberInput("abc")).toBe("");
  });

  it("空串/未填原样返回", () => {
    expect(normalizeNumberInput("")).toBe("");
    expect(normalizeNumberInput("   ")).toBe("");
  });
});
