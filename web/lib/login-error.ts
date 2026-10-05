// web/lib/login-error.ts
// 登录失败原因归一（2026-10-04 事故，issue #83）。
//
// 背景：/auth/callback 调边沿函数 wecom-oidc-callback 失败时，InsForge SDK 抛 InsForgeError——
//   服务端 body 的 `{ error }` 被挂到 `error.error` 上，而 `error.message` 取的是 body.message；
//   我们的边沿函数只回 `{ error }`（没有 message），于是 `String(error)` 只剩类名
//   "InsForgeError"，真实原因（如 "group scope unavailable, login denied"）在页面上完全丢失，
//   用户只看到「登录失败：InsForgeError」，排障要靠翻服务器日志。
// 本模块把「SDK 错误 → 可读原因 → 用户文案」两级归一收敛到一处；纯函数、可测。

type Unknown = Record<string, unknown>;

const asString = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

/** 从 functions.invoke 的 `{ data, error }` 取出可读失败原因（保留机器原因串，便于排障）。 */
export function describeFunctionError(data: unknown, error: unknown): string {
  const fromData = asString((data as Unknown | null)?.error);
  if (fromData) return fromData;
  if (error && typeof error === "object") {
    const e = error as Unknown;
    const fromErrorField = asString(e.error);
    if (fromErrorField) return fromErrorField;
    const fromMessage = asString(e.message);
    if (fromMessage) return fromMessage;
  }
  return asString(error) ?? "exchange_failed";
}

/** 机器原因 → 用户能看懂的一句话；未知原因原样透出（不吞，便于排障）。 */
const LOGIN_ERROR_TEXT: Record<string, string> = {
  group_claim_missing_login_denied: "账号未纳入任何组织分组，请联系管理员开通",
  "group scope unavailable, login denied": "账号未分配角色或门店范围，请联系管理员开通",
  user_inactive: "账号已停用，请联系管理员",
  missing_code: "登录信息不完整，请重新登录",
  state_mismatch: "登录会话已失效，请重新登录",
  invalid_state: "登录会话已失效，请重新登录",
  invalid_redirect_uri: "登录回调地址不合法，请联系管理员",
  failed_to_get_casdoor_token: "统一登录平台校验失败，请重新登录",
  failed_to_get_wecom_id: "未获取到企业微信身份，请重新登录",
  internal_error: "登录服务内部错误，请稍后重试",
  refresh_required: "登录态已过期，请重新登录",
  exchange_failed: "登录校验失败，请重新登录",
};

export function describeLoginError(reason: string): string {
  return LOGIN_ERROR_TEXT[reason] ?? reason;
}
