// web/lib/permission-audit.ts
// 权限变更审计写入（管理 API 写路径第二步；失败仅记日志不阻断主操作）
import { NextRequest } from 'next/server';

export interface AuditParams {
  action: string;                 // assign_role / upsert_data_permission / delete_data_permission / update_role
  subjectType: string;            // user / dept / role
  subjectId: string;
  before: unknown;                // 改动前 payload（可 null）
  after: unknown;                 // 改动后 payload
}

export function actorOf(req: NextRequest): { wecom_id: string; name: string | null } {
  return {
    wecom_id: req.cookies.get('wecom_userid')?.value ?? 'unknown',
    // name 由调用方从 org_users 查（可为空）
    name: null,
  };
}

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

export async function writeAudit(req: NextRequest, params: AuditParams): Promise<void> {
  try {
    const actor = actorOf(req);
    await fetch(`${POSTGREST_URL}/permission_audit`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        actor_wecom_id: actor.wecom_id, actor_name: actor.name,
        action: params.action, subject_type: params.subjectType, subject_id: params.subjectId,
        payload_before: params.before ?? null, payload_after: params.after ?? null,
      }),
    });
  } catch (e) {
    console.error('[permission-audit] write failed:', e);   // 降级：不阻断主操作
  }
}
