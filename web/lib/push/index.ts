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
  selector: Selector;
  operatorId: string;
  broadcastPerm: boolean;
  deliver?: boolean; // false = shadow (默认)
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
  return {
    brands: Array.isArray(row.brands) ? (row.brands as string[]) : undefined,
    branch_nums: Array.isArray(row.branch_nums) ? (row.branch_nums as string[]) : undefined,
    categories: Array.isArray(row.categories) ? (row.categories as string[]) : undefined,
    can_see_cost: typeof row.can_see_cost === 'boolean' ? row.can_see_cost : undefined,
  };
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
          // URL 型变量
          if (code.endsWith('_url')) {
            const view = code.replace('_url', '');
            const params = new URLSearchParams();
            if (perms.brands?.length) params.set('brand', perms.brands.join(','));
            if (perms.branch_nums?.length) params.set('branch', perms.branch_nums.join(','));
            if (perms.categories?.length) params.set('category', perms.categories.join(','));
            params.set('jwt', jwt);
            return `/report/${view}?${params.toString()}`;
          }
          // 数值型 → 占位（实际由 Novu 模板渲染）
          return `{{${code}}}`;
        },
        group.perms
      );

      return {
        ...group,
        rendered,
      };
    })
  );

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
