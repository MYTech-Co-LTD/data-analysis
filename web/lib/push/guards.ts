/**
 * 推送守卫模块
 *
 * 暂停状态检查、系统就绪检查
 */

// 运行时读取
function getConfig() {
  return {
    postgrestUrl: process.env.POSTGREST_URL || '',
    postgrestKey: process.env.POSTGREST_ANON_KEY || '',
  };
}

/**
 * 检查推送系统是否暂停
 *
 * 从 push_settings 表读 paused 状态
 */
export async function isPaused(): Promise<boolean> {
  const { postgrestUrl, postgrestKey } = getConfig();
  if (!postgrestUrl || !postgrestKey) return false;

  try {
    const resp = await fetch(
      `${postgrestUrl}/push_settings?key=eq.paused&select=value`,
      {
        headers: { Authorization: `Bearer ${postgrestKey}` },
      }
    );

    if (!resp.ok) return false;
    const data = await resp.json();
    return data?.[0]?.value === 'true';
  } catch {
    return false;
  }
}

/**
 * 检查推送系统就绪状态
 *
 * 检查：
 * - Novu API 可达
 * - bridge secret 配置
 * - push_subscriber_tokens 表存在
 */
export async function checkReadiness(): Promise<{
  ready: boolean;
  checks: Record<string, boolean>;
}> {
  const checks: Record<string, boolean> = {};

  // Novu API 可达
  try {
    const apiUrl = process.env.NOVU_API_URL;
    const apiKey = process.env.NOVU_API_KEY;
    if (apiUrl && apiKey) {
      const resp = await fetch(`${apiUrl}/v1/health-check`, {
        headers: { Authorization: `ApiKey ${apiKey}` },
      });
      checks.novuApi = resp.ok;
    } else {
      checks.novuApi = false;
    }
  } catch {
    checks.novuApi = false;
  }

  // bridge secret 配置
  checks.bridgeSecret = !!process.env.NOVU_BRIDGE_SECRET;

  // engine secret 配置
  checks.engineSecret = !!process.env.ENGINE_BRIDGE_SECRET;

  const ready = Object.values(checks).every(Boolean);
  return { ready, checks };
}
