/**
 * 推送引擎核心
 *
 * 契约来源：spec §5.2
 * - scope 签名分组：同权限用户一组，渲染一次
 * - 存在性校验：无权限/无活跃用户 → 跳过
 * - 悬空部门告警：部门下无用户 → 告警但仍继续
 */

import { scopeSignature } from './scope-signature';
import { type Perms } from './push-variables';

export type { Perms };

/**
 * 计算推送 scope
 * 读取 data_permissions 视图，返回该用户的有效 scope
 */
export type GetPermsForUser = (userId: string) => Promise<Perms | null>;

/**
 * 分组收件人
 *
 * 1. 读取每个收件人的 scope
 * 2. 按 scopeSignature 分组
 * 3. 无权限的收件人归入 skipped
 *
 * @returns { groups, skipped }
 * - groups: 按 scope 签名分组，每组包含 signature、members、perms
 * - skipped: 无权限的用户 id 列表
 */
export async function groupRecipients(
  userIds: string[],
  getPerms: GetPermsForUser
): Promise<{
  groups: Array<{ signature: string; members: string[]; perms: Perms }>;
  skipped: string[];
}> {
  const sigMap = new Map<string, { members: string[]; perms: Perms }>();
  const skipped: string[] = [];

  for (const userId of userIds) {
    const perms = await getPerms(userId);
    if (!perms) {
      skipped.push(userId);
      continue;
    }
    const sig = scopeSignature(perms);
    const existing = sigMap.get(sig);
    if (existing) {
      existing.members.push(userId);
    } else {
      sigMap.set(sig, { members: [userId], perms });
    }
  }

  const groups = Array.from(sigMap.entries()).map(([signature, { members, perms }]) => ({
    signature,
    members,
    perms,
  }));

  return { groups, skipped };
}
