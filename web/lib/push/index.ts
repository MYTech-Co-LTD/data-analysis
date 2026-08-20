/**
 * run_push 推送引擎编排
 *
 * 契约来源：spec §5.2 + S5 §5.3
 *
 * 十不变量：
 * 1. getPerms 全部走 strict 注入（无 7 天 claims 入参）
 * 2. owner 校验注入（configure=false → throw + paused 回调）
 * 3. 变量 scope 匹配
 * 4. 组 can_see_cost=false + cost_sensitive → 脱敏
 * 5. 分页游标含 JWT 代签（非明文 db_user/db_pass）
 * 6. 同 scope 渲染一次
 * 7. bulk ≤100 分批
 * 8. engine_sig 注入
 * 9. subscriber upsert 顺带写 push_subscriber_tokens
 * 10. Novu 故障 → fallback 逐组同产物
 */

import { randomUUID } from 'crypto';
import { type Selector, resolveRecipients, type ResolverDeps } from './selectors';
import { type Perms, groupRecipients } from './engine';
import { renderVariables } from './render';
import { triggerBulk, upsertSubscriber, newBridgeToken } from './novu-client';
import { fallbackSend, type FallbackGroup } from './fallback';
import { getPushVariables } from './push-variables';
import { isPaused } from './guards';
import { auditPushTrigger, auditPushPayload } from './audit';
import { renderPresetContent, type MessagePreset } from './message-preset';

// 运行时配置
function getConfig() {
  return {
    postgrestUrl: process.env.POSTGREST_URL || '',
    postgrestKey: process.env.POSTGREST_ANON_KEY || '',
    fallbackMode: process.env.PUSH_FALLBACK_MODE === 'always',
  };
}

export interface RunPushOpts {
  workflowId: string;
  /** 按模板库直取 preset（优先于按 workflowId 查找） */
  presetId?: string;
  selector: Selector;
  operatorId: string;
  broadcastPerm: boolean;
  deliver?: boolean; // false = shadow (默认)
  /** 数值取值目标：follow=今天落区间（默认，向后兼容）；fixed=锁定 target_id */
  targetMode?: 'follow' | 'fixed';
  targetId?: number;
  /** route 兼容字段（/api/push 透传，暂无消费方） */
  variables?: Record<string, string>;
}

export interface RunPushResult {
  txnId: string;
  groups: number;
  recipients: number;
  skipped: string[];
  mode: 'shadow' | 'live';
  fallbackUsed: boolean;
  error?: string;
  /** 逐组渲染产物（shadow.ts 消费：deliver=false 干跑落盘；live 模式亦返回供调试/审计页） */
  renderedGroups?: Array<{
    signature: string;
    members: string[];
    perms: Perms;
    rendered: Record<string, string>;
  }>;
}

/**
 * 查询用户权限（strict RPC）
 *
 * 不变量 1：全部走 strict RPC，不走 JWT claims 7 天缓存
 * Review 修复（B4）：RPC 参数名 p_wecom_id，入参为用户 wecom_id（非 org_users.id UUID）。
 */
async function getPermsStrict(wecomId: string): Promise<Perms | null> {
  const { postgrestUrl, postgrestKey } = getConfig();
  if (!postgrestUrl || !postgrestKey) return null;

  const resp = await fetch(
    `${postgrestUrl}/rpc/get_user_perms_strict`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${postgrestKey}`,
      },
      // 参数名必须与 migration 170 的 p_wecom_id 一致（曾误写 p_user_id → 400）
      body: JSON.stringify({ p_wecom_id: wecomId }),
    }
  );

  if (!resp.ok) return null;
  // migration 170 返回标量 JSONB（对象或 null），PostgREST 直接以 body 返回；
  // 不是 [{...}] 数组——旧的 data[0] 解构永远拿不到值（静默 null）。
  const data = await resp.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  // M4/方案 A：解析新形状 data_scope + fields + departments（get_user_perms 双形输出）
  const ds = (row.data_scope ?? {}) as Record<string, unknown>;
  const f = (row.fields ?? {}) as Record<string, unknown>;
  return {
    data_scope: {
      brands: Array.isArray(ds.brands) ? (ds.brands as string[]) : [],
      categories: Array.isArray(ds.categories) ? (ds.categories as string[]) : [],
      branch_nums: Array.isArray(ds.branch_nums) ? (ds.branch_nums as string[]) : [],
    },
    fields: { cost: f.cost === true },
    departments: Array.isArray(row.departments) ? (row.departments as string[]) : [],
  };
}

// 语义指标 → achievement 视图 metric_code 映射（§12.1 数值取值；扩展时在此追加）
// outbound_amount：push_variables.metric_code 的 FK 真名（metric_registry，迁移 173/204）——
//   生产 registry 无 outbound_amt 键，只有 outbound_amount；保留旧键兼容历史行。
const METRIC_TO_VIEW: Record<string, string> = {
  sale_amount: 'sale',
  sale_rate: 'sale',
  delivery_amount: 'delivery',
  outbound_amt: 'outbound_amt',
  outbound_amount: 'outbound_amt',
  outbound_profit: 'outbound_profit',
};

const fmtCN = (n: number): string => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(Math.round(n));

/**
 * 数值指标取值（§12.1，2026-08-20；同日修复跨周期累计 bug）：
 *   用代签 JWT 查 report_achievement_gen（RLS 按 data_scope 裁剪）。
 *   视图按目标周期（target）一行——必须只取 status=active 的当前周期行，
 *   不能 SUM 全部行（closed 历史周期会被跨期累计：实测 7月+8月 SUM 出 81.7% 假达成率）。
 *   比率直接用视图 achievement_rate（与报表页同口径），金额用 actual_value。
 *   查询失败或取不到 → null（该变量不渲染，避免占位符）。
 */
/** rate 类变量判定：var_code 以 _rate 结尾或为 achievement_rate（rate 按视图 achievement_rate 列取） */
const isRateVar = (code: string) => /_rate$/.test(code) || code === 'achievement_rate';

async function resolveNumericValue(
  metricCode: string | undefined,
  jwt: string,
  target: { mode: 'follow' | 'fixed'; id?: number } = { mode: 'follow' },
  varCode?: string,
): Promise<string | null> {
  if (!metricCode) return null;
  const viewMetric = METRIC_TO_VIEW[metricCode];
  if (!viewMetric) return null;
  const { postgrestUrl } = getConfig();
  if (!postgrestUrl) return null;
  try {
    // follow：今天落区间（周期结束自动取不到→变量跳过；提前建下月不误取）
    //   tie-break：start_date.desc, end_date.asc = 取开始最晚结束最早的周期（粒度最细，8月优先于Q3）
    // fixed：锁定 target_id（视图外层已输出 target_id 列，见 report_achievement_gen.sql）
    // 「今天」按北京时区取（UTC+8）——否则北京 0-8 点触发会取 UTC 昨日，周期切换日清晨推错周期
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const targetFilter = target.mode === 'fixed' && target.id
      ? `&target_id=eq.${target.id}`
      : `&start_date=lte.${today}&end_date=gte.${today}`;
    const resp = await fetch(
      `${postgrestUrl}/report_achievement_gen?select=metric_code,actual_value,target_value,achievement_rate`
      + `&metric_code=eq.${viewMetric}&status=eq.active${targetFilter}`
      + `&order=start_date.desc,end_date.asc&limit=1`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    if (!resp.ok) return null;
    const rows = await resp.json() as Array<{ actual_value: number | null; achievement_rate: number | null }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (isRateVar(varCode ?? '')) {
      const rate = Number(row.achievement_rate);
      return rate > 0 ? `${(rate * 100).toFixed(1)}%` : null;
    }
    if (row.actual_value === null || row.actual_value === undefined) return null;
    return `¥${fmtCN(Number(row.actual_value))}`;
  } catch {
    return null;
  }
}

/**
 * 加载 workflow 的消息呈现 preset（push_message_presets；平台能力 2026-08-20）
 * 无 preset / 查询失败 → null（走默认 Novu content，向后兼容）
 */
async function loadWorkflowPreset(workflowId: string, presetId?: string): Promise<MessagePreset | null> {
  const { postgrestUrl, postgrestKey } = getConfig();
  if (!postgrestUrl || !postgrestKey) return null;
  try {
    const where = presetId
      ? `preset_id=eq.${encodeURIComponent(presetId)}`
      : `workflow_id=eq.${encodeURIComponent(workflowId)}&enabled=eq.true`;
    const resp = await fetch(`${postgrestUrl}/push_message_presets?${where}`, {
      headers: { Authorization: `Bearer ${postgrestKey}` } },
    );
    if (!resp.ok) return null;
    const rows = await resp.json() as MessagePreset[];
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

/**
 * owner 校验
 *
 * 不变量 2：configure=false → throw + paused 回调
 */
async function checkOwnerPermission(operatorId: string): Promise<void> {
  const { postgrestUrl, postgrestKey } = getConfig();
  if (!postgrestUrl || !postgrestKey) throw new Error('PostgREST config missing, owner check cannot proceed');

  const resp = await fetch(
    `${postgrestUrl}/rpc/require_push_owner`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${postgrestKey}`,
      },
      body: JSON.stringify({ p_operator_id: operatorId }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`owner 校验失败: ${text}`);
  }

  const data = await resp.json();
  if (data?.paused) {
    throw new Error('推送系统已暂停');
  }
}

/**
 * 查询收件人 bridge_token + wecom_id
 *
 * Review 修复（B4）：bridge_token 在 push_subscriber_tokens（org_users 无此列）。
 * 无 token 行时生成 32B 高熵 token 并写入（幂等 merge-duplicates），保证 Novu 侧
 * webhookUrl 路径段始终可用。
 */
async function getRecipientInfo(
  wecomId: string
): Promise<{ bridgeToken: string; wecomId: string } | null> {
  const { postgrestUrl, postgrestKey } = getConfig();
  if (!postgrestUrl || !postgrestKey) return null;

  const resp = await fetch(
    `${postgrestUrl}/push_subscriber_tokens?wecom_id=eq.${encodeURIComponent(wecomId)}&select=bridge_token`,
    {
      headers: { Authorization: `Bearer ${postgrestKey}` },
    }
  );

  if (resp.ok) {
    try {
      const data = await resp.json();
      if (Array.isArray(data) && data[0]?.bridge_token) {
        return { bridgeToken: data[0].bridge_token, wecomId };
      }
    } catch {
      // fallthrough: 重新生成
    }
  }

  // 无 token → 生成并写入（best-effort；写失败则本轮跳过该收件人）
  const bridgeToken = newBridgeToken();
  const writeResp = await fetch(`${postgrestUrl}/push_subscriber_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${postgrestKey}`,
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ bridge_token: bridgeToken, wecom_id: wecomId }),
  });
  if (!writeResp.ok) return null;

  return { bridgeToken, wecomId };
}

/**
 * run_push 主编排
 */
export async function runPush(opts: RunPushOpts): Promise<RunPushResult> {
  const txnId = randomUUID();
  const deliver = opts.deliver ?? false;
  const mode = deliver ? 'live' : 'shadow';

  // ─── 四守卫 ───

  // 守卫 1: owner 校验
  await checkOwnerPermission(opts.operatorId);

  // 守卫 2: 暂停状态检查
  if (await isPaused()) {
    return {
      txnId,
      groups: 0,
      recipients: 0,
      skipped: [],
      mode,
      fallbackUsed: false,
      error: '推送系统已暂停',
    };
  }

  // 守卫 3: broadcastPerm 引擎闸（spec 5.2：绕插件同样拒）
  if (opts.selector.kind === 'all' && !opts.broadcastPerm) {
    throw new Error('全员推送需要 broadcastPerm 授权');
  }

  // ─── 解析收件人 ───

  const resolverDeps: ResolverDeps = {
    getUserById: async (wecomId) => {
      // person selector 的 ids 是企微 wecom_id（B4 修复：org_users.id 是 UUID，不能用于查询）
      const { postgrestUrl, postgrestKey } = getConfig();
      if (!postgrestUrl || !postgrestKey) return null;
      const resp = await fetch(
        `${postgrestUrl}/org_users?wecom_id=eq.${encodeURIComponent(wecomId)}&select=id,wecom_id,is_active`,
        { headers: { Authorization: `Bearer ${postgrestKey}` } }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data?.[0] || null;
    },
    getUsersByDept: async (deptId) => {
      // org_users 无 dept_id 列；部门归属在 department_ids(JSONB 数组)，用 jsonb 包含查询
      const { postgrestUrl, postgrestKey } = getConfig();
      if (!postgrestUrl || !postgrestKey) return [];
      const resp = await fetch(
        `${postgrestUrl}/org_users?department_ids=cs.${encodeURIComponent(JSON.stringify([String(deptId)]))}&is_active=eq.true&select=id,wecom_id,is_active`,
        { headers: { Authorization: `Bearer ${postgrestKey}` } }
      );
      if (!resp.ok) return [];
      return resp.json();
    },
    getUsersByRole: async (roleId) => {
      // 2026-08-18：role_id 过渡列已冻结（refresh_role_assignments 移除，§6.2 sunset），
      // 收件人改按 role_codes（casdoor 镜像，登录/drift 写穿）解析：roles.id → code → org_users.role_codes 数组包含。
      const { postgrestUrl, postgrestKey } = getConfig();
      if (!postgrestUrl || !postgrestKey) return [];
      const roleResp = await fetch(
        `${postgrestUrl}/roles?id=eq.${roleId}&select=code`,
        { headers: { Authorization: `Bearer ${postgrestKey}` } }
      );
      if (!roleResp.ok) return [];
      const roles = (await roleResp.json()) as Array<{ code?: string }>;
      const code = roles?.[0]?.code;
      if (!code) return [];
      const resp = await fetch(
        `${postgrestUrl}/org_users?role_codes=cs.${encodeURIComponent(JSON.stringify([code]))}&is_active=eq.true&select=id,wecom_id,is_active`,
        { headers: { Authorization: `Bearer ${postgrestKey}` } }
      );
      if (!resp.ok) return [];
      return resp.json();
    },
    getAllActiveUsers: async () => {
      const { postgrestUrl, postgrestKey } = getConfig();
      if (!postgrestUrl || !postgrestKey) return [];
      const resp = await fetch(
        `${postgrestUrl}/org_users?is_active=eq.true&select=id,wecom_id,is_active`,
        { headers: { Authorization: `Bearer ${postgrestKey}` } }
      );
      if (!resp.ok) return [];
      return resp.json();
    },
  };

  const { recipients, danglingDepts } = await resolveRecipients(
    opts.selector,
    resolverDeps
  );

  // 悬空部门告警（不阻断，日志记录）
  if (danglingDepts.length > 0) {
    console.warn(`[push] 悬空部门: ${danglingDepts.join(',')}，已跳过`);
  }

  if (recipients.length === 0) {
    return {
      txnId,
      groups: 0,
      recipients: 0,
      skipped: [],
      mode,
      fallbackUsed: false,
      error: '无有效收件人',
    };
  }

  // ─── 逐人 strict → 分组 ───

  const { groups, skipped } = await groupRecipients(recipients, getPermsStrict);

  // ─── 渲染 ───

  const enabledVars = (await getPushVariables()).filter((v) => v.enabled);
  const varCodes = enabledVars.map((v) => v.var_code);
  const scopeSignatures = groups.map((g) => g.signature);

  const renderedGroups = await Promise.all(
    groups.map(async (group) => {
      // 不变量 3+4: 变量 scope 匹配 + cost 脱敏
      const rendered = await renderVariables(
        enabledVars,
        async (code, perms, jwt) => {
          // URL 型变量（S7：branch_nums 非空才渲染；缺口 2：URL 只带 jwt 防超长被企微截断；
          //   2026-08-19 绝对 URL——PUSH_BRIDGE_BASE_URL 剥离 /api/wecom-bridge 得 app 根，相对路径企微不可点）
          if (code.endsWith('_url')) {
            if (!perms.data_scope?.branch_nums?.length) return null;
            const view = code.replace('_url', '');
            const base = (process.env.PUSH_BRIDGE_BASE_URL || '').replace(/\/api\/wecom-bridge$/, '');
            return `${base}/report/${view}?jwt=${encodeURIComponent(jwt)}`;
          }
          // 数值型 → 语义视图取真值（§12.1）；取不到 → null（该变量不渲染，M7 不拦）
          const v = enabledVars.find((x) => x.var_code === code);
          return await resolveNumericValue(v?.metric_code, jwt, { mode: opts.targetMode ?? 'follow', id: opts.targetId }, code);
        },
        group.perms
      );

      return {
        ...group,
        rendered,
      };
    })
  );

  // ─── 消息呈现 preset（平台能力 2026-08-20）───
  //   workflow 配了 push_message_presets → 渲染 message_content（JSON 契约）进 payload，
  //   Novu content 固定 {{{message_content}}}（triple-stash：平铺上下文无 payload. 前缀 +
  //   双花括号会 HTML 转义破坏 JSON 契约，详见 message-preset.ts 头注释），
  const preset = await loadWorkflowPreset(opts.workflowId, opts.presetId);
  if (preset) {
    for (const g of renderedGroups) {
      g.rendered.message_content = renderPresetContent(preset, g.rendered);
    }
  }

  // ─── 审计日志（预写） ───

  await auditPushTrigger({
    txnId,
    operator: opts.operatorId,
    workflowId: opts.workflowId,
    selector: opts.selector,
    groups: groups.length,
    recipients,
    scopeSignatures,
    varCodes,
    skipped,
    deliverMode: mode,
  });

  // payload 快照
  for (const group of renderedGroups) {
    await auditPushPayload({ txnId, groupSig: group.signature, payload: group.rendered });
  }

  // ─── 投递 ───

  let fallbackUsed = false;

  if (deliver) {
    // M7 fail-closed 守卫：数值变量计算未实现前，禁止把字面 `{{code}}` 占位符投给用户
    for (const group of renderedGroups) {
      for (const [code, value] of Object.entries(group.rendered)) {
        if (typeof value === 'string' && /^\{\{.*\}\}$/.test(value)) {
          throw new Error(
            `[push] 变量 ${code} 仍是模板占位符（数值变量计算未实现），live 模式拒绝投递；` +
            `请先实现语义视图取值或仅启用 *_url 变量`,
          );
        }
      }
    }

    // 不变量 9: subscriber upsert + push_subscriber_tokens
    const subscriberPayloads: Array<{
      subscriberId: string;
      payload: Record<string, unknown>;
      wecomId: string;
      bridgeToken: string;
    }> = [];

    for (const group of renderedGroups) {
      for (const wecomId of group.members) {
        const info = await getRecipientInfo(wecomId);
        if (!info) {
          skipped.push(wecomId);
          continue;
        }

        await upsertSubscriber(
          {
            subscriberId: wecomId,
            data: { wecom_id: info.wecomId, bridge_token: info.bridgeToken },
          },
          info.bridgeToken
        );

        subscriberPayloads.push({
          subscriberId: wecomId,
          payload: group.rendered,
          wecomId: info.wecomId,
          // 逐人 bridge 路由：triggerBulk 据此拼 overrides.providers['chat-webhook'].webhookUrl
          bridgeToken: info.bridgeToken,
        });
      }
    }

    // 不变量 7+8: bulk ≤100 + engine_sig（txnId 贯穿，bridge 验签依据）
    const { errors, failedSubscribers } = await triggerBulk(
      opts.workflowId,
      subscriberPayloads,
      txnId
    );

    // 不变量 10: Novu 故障 → fallback（M8：只补失败批次的收件人，避免已投递用户重复收）
    if (errors.length > 0 || getConfig().fallbackMode) {
      fallbackUsed = true;

      const failedSet = new Set(failedSubscribers ?? []);
      const fallbackGroups: FallbackGroup[] = [];
      for (const group of renderedGroups) {
        // members 已统一为 wecom_id（B4 修复），无需二次查询
        const members = getConfig().fallbackMode
          ? group.members
          : group.members.filter((m) => failedSet.has(m));
        if (members.length > 0) {
          fallbackGroups.push({
            signature: group.signature,
            members,
            perms: group.perms,
            rendered: group.rendered,
          });
        }
      }

      await fallbackSend(fallbackGroups, txnId, opts.workflowId);
    }
  }

  return {
    txnId,
    groups: groups.length,
    recipients: recipients.length,
    skipped,
    mode,
    fallbackUsed,
    renderedGroups,
  };
}
