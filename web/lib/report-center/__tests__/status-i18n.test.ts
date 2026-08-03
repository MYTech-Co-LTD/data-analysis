import { describe, it, expect } from "vitest";
import { statusToZh } from "../status-i18n";

describe("statusToZh", () => {
  it("complete → 已完成", () => {
    expect(statusToZh("complete")).toBe("已完成");
  });
  it("partial → 部分", () => {
    expect(statusToZh("partial")).toBe("部分");
  });
  it("missing → 缺失", () => {
    expect(statusToZh("missing")).toBe("缺失");
  });
  it("not_ready → 未就绪", () => {
    expect(statusToZh("not_ready")).toBe("未就绪");
  });
  it("未知 code → 未就绪（兜底）", () => {
    expect(statusToZh("whatever")).toBe("未就绪");
  });
});
