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
import { triggerBulk, upsertSubscriber } from './novu-client';
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
}

/**
 * 查询用户权限（strict RPC）
 *
 * 不变量 1：全部走 strict RPC，不走 JWT claims 7 天缓存
 */
async function getPermsStrict(userId: string): Promise<Perms | null> {
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
      body: JSON.stringify({ p_user_id: userId }),
    }
  );

  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.length) return null;

  const row = data[0];
  return {
    brands: row.brands,
    branch_nums: row.branch_nums,
    categories: row.categories,
    can_see_cost: row.can_see_cost,
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
 */
async function getRecipientInfo(
  userId: string
): Promise<{ bridgeToken: string; wecomId: string } | null> {
  const { postgrestUrl, postgrestKey } = getConfig();
  if (!postgrestUrl || !postgrestKey) return null;

  const resp = await fetch(
    `${postgrestUrl}/org_users?id=eq.${userId}&select=bridge_token,wecom_id`,
    {
      headers: {
        Authorization: `Bearer ${postgrestKey}`,
      },
    }
  );

  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.length || !data[0].bridge_token || !data[0].wecom_id) return null;
  return { bridgeToken: data[0].bridge_token, wecomId: data[0].wecom_id };
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
    getUserById: async (id) => {
      const { postgrestUrl, postgrestKey } = getConfig();
      if (!postgrestUrl || !postgrestKey) return null;
      const resp = await fetch(
        `${postgrestUrl}/org_users?id=eq.${id}&select=id,wecom_id,dept_id,is_active`,
        { headers: { Authorization: `Bearer ${postgrestKey}` } }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data?.[0] || null;
    },
    getUsersByDept: async (deptId) => {
      const { postgrestUrl, postgrestKey } = getConfig();
      if (!postgrestUrl || !postgrestKey) return [];
      const resp = await fetch(
        `${postgrestUrl}/org_users?dept_id=eq.${deptId}&is_active=eq.true&select=id,wecom_id,dept_id,is_active`,
        { headers: { Authorization: `Bearer ${postgrestKey}` } }
      );
      if (!resp.ok) return [];
      return resp.json();
    },
    getUsersByRole: async (roleId) => {
      const { postgrestUrl, postgrestKey } = getConfig();
      if (!postgrestUrl || !postgrestKey) return [];
      const resp = await fetch(
        `${postgrestUrl}/org_users?role_id=eq.${roleId}&is_active=eq.true&select=id,wecom_id,is_active,role_id`,
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
    // 不变量 9: subscriber upsert + push_subscriber_tokens
    const subscriberPayloads: Array<{
      subscriberId: string;
      payload: Record<string, unknown>;
      wecomId: string;
    }> = [];

    for (const group of renderedGroups) {
      for (const userId of group.members) {
        const info = await getRecipientInfo(userId);
        if (!info) {
          skipped.push(userId);
          continue;
        }

        await upsertSubscriber(
          {
            subscriberId: userId,
            data: { wecom_id: info.wecomId, bridge_token: info.bridgeToken },
          },
          info.bridgeToken
        );

        subscriberPayloads.push({
          subscriberId: userId,
          payload: group.rendered,
          wecomId: info.wecomId,
        });
      }
    }

    // 不变量 7+8: bulk ≤100 + engine_sig
    const { errors } = await triggerBulk(
      opts.workflowId,
      subscriberPayloads
    );

    // 不变量 10: Novu 故障 → fallback
    if (errors.length > 0 || getConfig().fallbackMode) {
      fallbackUsed = true;

      // 构建 fallback groups（用 wecom_id）
      const fallbackGroups: FallbackGroup[] = [];
      for (const group of renderedGroups) {
        const wecomIds: string[] = [];
        for (const userId of group.members) {
          const info = await getRecipientInfo(userId);
          if (info) wecomIds.push(info.wecomId);
        }
        if (wecomIds.length > 0) {
          fallbackGroups.push({
            signature: group.signature,
            members: wecomIds,
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
  };
}
