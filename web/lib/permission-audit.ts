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
    name: null, // 真实姓名由 writeAudit 写审计前从 org_users 查（查不到为 null）
  };
}

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// F5：actor_name 从 org_users 按 wecom_userid 查；写审计后检查 r.ok（PostgREST 4xx 记日志不静默丢）。
// 全程 try/catch 降级：审计写失败仅记日志、不阻断主操作返回。
export async function writeAudit(req: NextRequest, params: AuditParams): Promise<void> {
  try {
    const actor = actorOf(req);
    let name: string | null = null;
    try {
      const nr = await fetch(`${POSTGREST_URL}/org_users?select=name&wecom_id=eq.${encodeURIComponent(actor.wecom_id)}`, { headers: H, cache: 'no-store' });
      if (nr.ok) {
        const arr = await nr.json();
        if (Array.isArray(arr) && arr[0]?.name != null) name = String(arr[0].name);
      }
    } catch (e) {
      console.error('[permission-audit] actor name lookup failed:', e); // 降级：name 留 null 仍写审计
    }
    const ar = await fetch(`${POSTGREST_URL}/permission_audit`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        actor_wecom_id: actor.wecom_id, actor_name: name,
        action: params.action, subject_type: params.subjectType, subject_id: params.subjectId,
        payload_before: params.before ?? null, payload_after: params.after ?? null,
      }),
    });
    if (!ar.ok) {
      const detail = await ar.text().catch(() => '');
      console.error(`[permission-audit] write failed: ${ar.status} ${detail}`);
    }
  } catch (e) {
    console.error('[permission-audit] write failed:', e);   // 降级：不阻断主操作
  }
}
