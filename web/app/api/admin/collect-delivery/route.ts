// web/app/api/admin/collect-delivery/route.ts
// 配送明细采集手动触发入口（照 collect-lemeng route）
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { collectDeliveryOnce, getTodayChina, getYesterdayChina, LEMENG_SECRET_KEY, type DeliveryCollectResult } from '@/lib/collect-delivery';
import { notifyWecom } from '@/lib/notify';
import { ensureSchedulerInitialized } from '@/lib/scheduler';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const MAX_VERIFY_RETRIES = 3;

export async function POST(req: NextRequest) {
  const startedAt = new Date();
  try {
    if (!LEMENG_SECRET_KEY) return NextResponse.json({ success: false, error: 'LEMENG_SECRET_KEY not configured' }, { status: 500 });
    const { task_id } = await req.json();
    const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
    const { data: task } = await client.database.from('collect_tasks').select('id,name,source_id,params').eq('id', task_id).single();
    if (!task) return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 });

    const { data: cred } = await client.database.from('auth_credentials').select('credential_data').eq('source_id', task.source_id).single();
    let credentials: Record<string, string> = {};
    if (cred?.credential_data) { try { credentials = JSON.parse(cred.credential_data); } catch {} }
    const authToken = credentials.token?.startsWith('Bearer ') ? credentials.token : `Bearer ${credentials.token}`;
    if (!credentials.token) return NextResponse.json({ success: false, error: 'No token' }, { status: 400 });

    const params = task.params || {};
    const distributionBranch = Number(params.distribution_branch_num) || 99;
    const branchNumsStr = String(distributionBranch);
    const limit = params.page_size || 200;
    const today = getTodayChina();
    const lookback = params.lookback_days ?? 1;
    const startD = (() => { const d = new Date(); const c = new Date(d.getTime() + 8 * 3600 * 1000); c.setDate(c.getDate() - lookback); return c.toISOString().slice(0, 10); })();
    const dates = params.date_mode === 'today'
      ? { from: `${startD} 00:00:00`, to: `${today} 23:59:59` }
      : { from: `${getYesterdayChina()} 00:00:00`, to: `${getYesterdayChina()} 23:59:59` };

    await ensureSchedulerInitialized();

    let lastResult: DeliveryCollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
    let verified = false;
    for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
      lastResult = await collectDeliveryOnce(authToken, distributionBranch, branchNumsStr, dates.from, dates.to, limit);
      if (lastResult.error.startsWith('Token expired')) return NextResponse.json({ success: false, error: lastResult.error }, { status: 401 });
      if (lastResult.apiTotal === 0) {
        await client.database.from('collect_tasks').update({ last_run_at: new Date().toISOString() }).eq('id', task_id);
        return NextResponse.json({ success: true, rows_collected: 0, dates });
      }
      verified = lastResult.records.length >= lastResult.apiTotal && !lastResult.error;
      if (verified) break;
      if (attempt < MAX_VERIFY_RETRIES) await new Promise(r => setTimeout(r, 5000));
      else {
        await notifyWecom('❌ 手动配送采集不完整', `**任务**: ${task.name}\n**采集**: ${lastResult.records.length}/${lastResult.apiTotal}\n**错误**: ${lastResult.error || '无'}`);
        lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): ${lastResult.error ? '写入失败' : '条数不足'}`;
      }
    }
    const finishedAt = new Date();
    await client.database.from('collect_tasks').update({ last_run_at: finishedAt.toISOString() }).eq('id', task_id);
    const finalStatus = lastResult.error ? 'partial' : 'success';
    await client.database.from('collect_logs').insert([{
      task_id, status: finalStatus, started_at: startedAt.toISOString(), finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(), rows_collected: lastResult.records.length,
      error_message: lastResult.error || null,
      response_summary: { storage_path: lastResult.storagePath, page_failures: lastResult.pageFailures ?? 0, verification: { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, verified } },
    }]);
    return NextResponse.json({
      success: verified && !lastResult.error, rows_collected: lastResult.records.length, dates,
      api_total: lastResult.apiTotal, verification: { verified, missing: lastResult.apiTotal - lastResult.records.length },
      storage_path: lastResult.storagePath || undefined, error: lastResult.error || undefined,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
