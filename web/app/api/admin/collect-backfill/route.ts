// web/app/api/admin/collect-backfill/route.ts
// 按日期补采：指定 task_id + 日期范围，full 模式重采该范围（修复漏采/补历史缺口）
// 复用 scheduler 的凭证解析 + collect 函数；full 模式覆盖写
import { NextRequest, NextResponse } from 'next/server';
import { runCollectBackfill } from '@/lib/collect-backfill';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

// POST { task_id, date_from, date_to } (YYYY-MM-DD)
export async function POST(req: NextRequest) {
  const b = await req.json();
  const { task_id, date_from, date_to } = b;
  if (!task_id || !date_from || !date_to) return NextResponse.json({ ok: false, error: '缺 task_id/date_from/date_to' }, { status: 400 });

  // 取任务
  const tr = await fetch(`${POSTGREST_URL}/collect_tasks?id=eq.${task_id}&select=*`, { headers: H });
  const task = (await tr.json())[0];
  if (!task) return NextResponse.json({ ok: false, error: '任务不存在' }, { status: 404 });

  // 取凭证（auth_credentials by source_id）
  const cr = await fetch(`${POSTGREST_URL}/auth_credentials?source_id=eq.${task.source_id}&select=credential_data`, { headers: H });
  const credRow = (await cr.json())[0];
  const cred = credRow?.credential_data ? JSON.parse(credRow.credential_data) : {};
  if (!cred.token) return NextResponse.json({ ok: false, error: '无凭证 token（source ' + task.source_id + '）' }, { status: 400 });
  const authToken = cred.token.startsWith('Bearer ') ? cred.token : `Bearer ${cred.token}`;

  // 分派逻辑抽到共享 lib（route + scheduler/C0 autoBackfill 共用）
  let result: any;
  try {
    result = await runCollectBackfill(task, authToken, date_from, date_to);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
  return NextResponse.json({
    ok: !result.error, records: result.records?.length || 0, apiTotal: result.apiTotal,
    error: result.error, storagePath: result.storagePath,
  });
}
