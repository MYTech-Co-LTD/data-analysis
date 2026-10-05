// web/lib/__tests__/login-error.test.ts
// issue #83：登录失败原因不得被 SDK 吞成 "InsForgeError"。
import { describe, expect, it } from "vitest";

import { describeFunctionError, describeLoginError } from "../login-error";

describe("describeFunctionError", () => {
  it("优先取 data.error（2xx 但 body 报错的形状）", () => {
    expect(describeFunctionError({ error: "user_inactive" }, null)).toBe("user_inactive");
  });

  it("SDK InsForgeError：真实原因在 error.error，message 为空", () => {
    // 复刻 SDK 形状：message 取 body.message（我们的边沿函数不返回 message → 空串），
    // 服务端 { error } 被平铺到 error.error。旧代码 String(error) 只剩 "InsForgeError"。
    const err = Object.assign(new Error(""), {
      name: "InsForgeError",
      error: "group scope unavailable, login denied",
      statusCode: 503,
    });
    expect(describeFunctionError(null, err)).toBe("group scope unavailable, login denied");
    expect(String(err)).toBe("InsForgeError"); // 佐证：这就是页面上原来显示的东西
  });

  it("回退 message / 字符串 / 兜底", () => {
    expect(describeFunctionError(null, new Error("boom"))).toBe("boom");
    expect(describeFunctionError(null, "raw")).toBe("raw");
    expect(describeFunctionError(null, null)).toBe("exchange_failed");
  });
});

describe("describeLoginError", () => {
  it("已知原因给人话", () => {
    expect(describeLoginError("group scope unavailable, login denied")).toContain("请联系管理员");
    expect(describeLoginError("group_claim_missing_login_denied")).toContain("请联系管理员");
  });

  it("未知原因原样透出（不吞）", () => {
    expect(describeLoginError("weird_thing")).toBe("weird_thing");
  });
});
