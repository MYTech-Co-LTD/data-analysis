/**
 * 收件人 selector 解析模块
 *
 * 契约来源：spec §5.1
 * - kind: dept / person / role / all
 * - resolveRecipients 负责去重、按 kind 查询
 */

export interface Selector {
  kind: 'dept' | 'person' | 'role' | 'all';
  ids?: string[];
}

export interface UserRecord {
  id: string;
  wecom_id: string;
  dept_id?: number;
  is_active: boolean;
  role_id?: number;
}

/**
 * 从 user_permissions 视图查用户记录
 * 抽象为依赖注入，方便测试
 */
export type GetUserById = (id: string) => Promise<UserRecord | null>;
export type GetUsersByDept = (deptId: number) => Promise<UserRecord[]>;
export type GetUsersByRole = (roleId: number) => Promise<UserRecord[]>;
export type GetAllActiveUsers = () => Promise<UserRecord[]>;

export interface ResolverDeps {
  getUserById: GetUserById;
  getUsersByDept: GetUsersByDept;
  getUsersByRole: GetUsersByRole;
  getAllActiveUsers: GetAllActiveUsers;
}

/**
 * 解析 selector 为收件人列表（按 wecom_id 去重后的数组）
 *
 * Review 修复（B4）：收件人身份统一为 wecom_id（与 get_user_perms_strict /
 * push_subscriber_tokens / Casdoor 一致；org_users.id 是 UUID，只作行键）。
 *
 * 返回 { recipients, danglingDepts }
 * - recipients: 去重后的 wecom_id 数组
 * - danglingDepts: selector.kind='dept' 但该部门下无活跃用户
 */
export async function resolveRecipients(
  selector: Selector,
  deps: ResolverDeps
): Promise<{ recipients: string[]; danglingDepts: number[] }> {
  const seen = new Set<string>();
  const danglingDepts: number[] = [];

  if (selector.kind === 'all') {
    const users = await deps.getAllActiveUsers();
    for (const u of users) {
      if (u.is_active && u.wecom_id) seen.add(u.wecom_id);
    }
    return { recipients: [...seen], danglingDepts: [] };
  }

  if (selector.kind === 'person') {
    for (const id of selector.ids ?? []) {
      const u = await deps.getUserById(id); // id = wecom_id
      if (u?.is_active && u.wecom_id) seen.add(u.wecom_id);
    }
    return { recipients: [...seen], danglingDepts: [] };
  }

  if (selector.kind === 'dept') {
    for (const deptId of selector.ids ?? []) {
      const n = Number(deptId);
      if (isNaN(n)) {
        console.warn(`[push] invalid dept id: ${deptId}, skipped`);
        continue;
      }
      const users = await deps.getUsersByDept(n);
      const active = users.filter(u => u.is_active && u.wecom_id);
      if (active.length === 0) {
        danglingDepts.push(n);
      }
      for (const u of active) seen.add(u.wecom_id);
    }
    return { recipients: [...seen], danglingDepts };
  }

  if (selector.kind === 'role') {
    for (const roleId of selector.ids ?? []) {
      const n = Number(roleId);
      if (isNaN(n)) {
        console.warn(`[push] invalid role id: ${roleId}, skipped`);
        continue;
      }
      const users = await deps.getUsersByRole(n);
      for (const u of users) {
        if (u.is_active && u.wecom_id) seen.add(u.wecom_id);
      }
    }
    return { recipients: [...seen], danglingDepts: [] };
  }

  // 不应到达
  return { recipients: [], danglingDepts: [] };
}
