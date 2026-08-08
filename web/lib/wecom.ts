// 企业微信 OAuth 辅助（H5 网页授权 snsapi_base）
// 真实联调待「可信回调域名」就绪（企微后台配置 + 公网可达）。
import { insforge } from "@/lib/insforge";

// 构造企微授权 URL。未配置 CORPID/AGENT_ID 时返回空串（UI 可隐藏入口）。
export function buildWecomAuthUrl(redirectUri: string, state = "mobile"): string {
  const corpId = process.env.NEXT_PUBLIC_WECOM_CORP_ID;
  const agentId = process.env.NEXT_PUBLIC_WECOM_AGENT_ID;
  if (!corpId || !agentId) return "";
  const params = new URLSearchParams({
    appid: corpId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "snsapi_base",
    state,
    agentid: agentId,
  });
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`;
}

// 构造 PC 端企微扫码登录 URL（login.work.weixin.qq.com SSO）。
// 回调同 H5（/auth/callback），复用 wecom-oauth function 换 userid。
export function buildWecomQrLoginUrl(redirectUri: string, state = "home"): string {
  const corpId = process.env.NEXT_PUBLIC_WECOM_CORP_ID;
  const agentId = process.env.NEXT_PUBLIC_WECOM_AGENT_ID;
  if (!corpId || !agentId) return "";
  const params = new URLSearchParams({
    login_type: "CorpApp",
    appid: corpId,
    agentid: agentId,
    redirect_uri: redirectUri,
    state,
  });
  return `https://login.work.weixin.qq.com/wwlogin/sso/login?${params.toString()}`;
}

// 调用 wecom-oauth edge function，用 code 换企微 userid / 会话。
// （旧 H5/PC 扫码直连企微路径，Casdoor 全量接管后可移除。）
export async function exchangeWecomCode(code: string) {
  const { data, error } = await insforge.functions.invoke("wecom-oauth", {
    method: "POST",
    body: { code },
  });
  return { data, error };
}

// 调 wecom-oidc-callback function：Casdoor authorization code → PostgREST JWT。
// 注意 redirectUri 必须与浏览器跳转 Casdoor 时用的 redirect_uri 一致。
export async function exchangeCasdoorCode(code: string, redirectUri: string) {
  const { data, error } = await insforge.functions.invoke("wecom-oidc-callback", {
    method: "POST",
    body: { code, redirect_uri: redirectUri },
  });
  return { data, error };
}

// 构造 Casdoor OIDC authorize URL（企微内 Silent；PC 经 Casdoor 扫码见 Task 9）。
// 未配置 NEXT_PUBLIC_CASDOOR_ISSUER/CLIENT_ID 时返回空串（UI 可隐藏入口）。
export function buildCasdoorAuthUrl(
  redirectUri: string,
  state: string,
  provider?: string
): string {
  const issuer = process.env.NEXT_PUBLIC_CASDOOR_ISSUER;
  const clientId = process.env.NEXT_PUBLIC_CASDOOR_CLIENT_ID;
  if (!issuer || !clientId) return "";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile",
    state,
  });
  if (provider) params.set("provider_hint", provider); // Casdoor 预选参数名是 provider_hint(实测 Task 6,非 provider)
  return `${issuer}/login/oauth/authorize?${params.toString()}`;
}
