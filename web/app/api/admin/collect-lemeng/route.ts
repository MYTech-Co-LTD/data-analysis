// web/app/api/admin/collect-lemeng/route.ts
// 乐檬数据采集 API（手动触发入口）

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { collectOnce, getYesterdayChina, getTodayChina, getDateOffsetChina, LEMENG_SECRET_KEY, CollectResult } from '@/lib/collect';
import { notifyWecom } from '@/lib/notify';
import { ensureSchedulerInitialized } from '@/lib/scheduler';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

// 对账重试最大次数
const MAX_VERIFY_RETRIES = 3;

// ===== 主流程 =====
export async function POST(req: NextRequest) {
  const startedAt = new Date();

  try {
    if (!LEMENG_SECRET_KEY) {
      return NextResponse.json({ success: false, error: "LEMENG_SECRET_KEY not configured" }, { status: 500 });
    }

    const body = await req.json();
    const { task_id } = body;

    const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });

    // 获取任务信息
    const { data: task } = await client.database
      .from('collect_tasks')
      .select('id, name, source_id, function_slug, params')
      .eq('id', task_id)
      .single();

    if (!task) {
      const finishedAt = new Date();
      await writeLog(client, task_id, startedAt, finishedAt, 'failed', 0, 'Task not found');
      return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 });
    }

    // 获取凭证
    let credentials: Record<string, string> = {};
    if (task.source_id) {
      const { data: cred } = await client.database
        .from('auth_credentials')
        .select('credential_data')
        .eq('source_id', task.source_id)
        .single();

      if (cred?.credential_data) {
        try { credentials = JSON.parse(cred.credential_data); } catch { /* ignore */ }
      }
    }

    const authToken = credentials.token?.startsWith('Bearer ') ? credentials.token : `Bearer ${credentials.token}`;
    if (!credentials.token) {
      const finishedAt = new Date();
      await writeLog(client, task_id, startedAt, finishedAt, 'failed', 0, 'No token configured');
      return NextResponse.json({ success: false, error: 'No token configured' }, { status: 400 });
    }

    const params = task.params || {};
    // 滚动回溯窗口：date_mode=today → [今天-lookback, 今天]，覆盖延迟生成/审核的单据（同天重采去重）
    const lookback = params.lookback_days ?? 1;
    const dates = params.date_mode === 'today'
      ? [getDateOffsetChina(-lookback), getTodayChina()]
      : (params.dates || [getYesterdayChina(), getYesterdayChina()]);
    const branchNums = params.branch_nums || [];
    const pageSize = params.page_size || 200;

    console.log(`[collect-lemeng] 手动触发: task=${task.name}, dates=${dates[0]}, branches=${branchNums.length}`);

    // 首次调用时初始化定时调度器
    await ensureSchedulerInitialized();

    const branchNumsStr = branchNums.join(',');

    // ===== 对账重试循环 =====
    let lastResult: CollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
    let verified = false;
    let retryCount = 0;

    for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
      console.log(`[collect-lemeng] === 第 ${attempt} 次采集 ${attempt > 1 ? '(对账重试)' : ''} ===`);

      lastResult = await collectOnce(authToken, branchNums, branchNumsStr, dates, pageSize);

      // Token 过期直接退出
      if (lastResult.error.startsWith('Token expired')) {
        const finishedAt = new Date();
        await writeLog(client, task_id, startedAt, finishedAt, 'failed', 0, lastResult.error);
        return NextResponse.json({ success: false, error: lastResult.error }, { status: 401 });
      }

      // 无数据直接退出
      if (lastResult.apiTotal === 0) {
        const finishedAt = new Date();
        await client.database
          .from('collect_tasks')
          .update({ last_run_at: finishedAt.toISOString() })
          .eq('id', task_id);
        await writeLog(client, task_id, startedAt, finishedAt, 'success', 0);
        return NextResponse.json({ success: true, rows_collected: 0, dates, branches: branchNums.length });
      }

      // 对账（铁律③：条数达标 AND 落盘无错 才算 verified；transform/merge 失败 → verified=false 触发重试/告警）
      const missing = lastResult.apiTotal - lastResult.records.length;
      verified = lastResult.records.length >= lastResult.apiTotal && !lastResult.error;

      if (verified) {
        console.log(`[collect-lemeng] ✅ 对账通过: ${lastResult.records.length}/${lastResult.apiTotal}`);
        break;
      }

      retryCount = attempt;

      const reason = lastResult.error ? `写入失败: ${lastResult.error}` : `缺少 ${missing} 条`;
      if (attempt < MAX_VERIFY_RETRIES) {
        console.warn(`[collect-lemeng] ⚠️ 对账失败: ${reason}，5 秒后重试...`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        console.error(`[collect-lemeng] ❌ ${MAX_VERIFY_RETRIES} 次均失败: ${reason}`);
        await notifyWecom(
          '❌ 手动采集不完整（已重试3次）',
          `**任务**: ${task.name}\n**日期**: ${dates[0]}\n**采集数**: ${lastResult.records.length}\n**API总数**: ${lastResult.apiTotal}\n**缺少**: ${missing} 条\n**错误**: ${lastResult.error || '无'}`
        );
        lastResult.error += `; 对账失败(重试${MAX_VERIFY_RETRIES}次): ${lastResult.error ? '写入失败' : `缺少 ${missing} 条`}`;
      }
    }

    // ===== 更新任务状态 =====
    const finishedAt = new Date();
    await client.database
      .from('collect_tasks')
      .update({ last_run_at: finishedAt.toISOString() })
      .eq('id', task_id);

    const finalStatus = lastResult.error ? 'partial' : 'success';
    await writeLog(
      client,
      task_id,
      startedAt,
      finishedAt,
      finalStatus,
      lastResult.records.length,
      lastResult.error || undefined,
      lastResult.storagePath || undefined,
      { api_total: lastResult.apiTotal, missing: lastResult.apiTotal - lastResult.records.length, page_failures: lastResult.pageFailures ?? 0, verified }
    );

    return NextResponse.json({
      success: verified && !lastResult.error,
      rows_collected: lastResult.records.length,
      dates,
      branches: branchNums.length,
      api_total: lastResult.apiTotal,
      verification: { verified, missing: lastResult.apiTotal - lastResult.records.length, retries: retryCount },
      storage_path: lastResult.storagePath || undefined,
      error: lastResult.error || undefined,
      sample: lastResult.records.slice(0, 2),
    });

  } catch (error: any) {
    console.error('[collect-lemeng] Fatal error:', error);
    const finishedAt = new Date();

    try {
      const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
      const body = await req.json();
      await writeLog(client, body.task_id, startedAt, finishedAt, 'failed', 0, error.message);
    } catch { /* ignore */ }

    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// ===== 写入日志 =====
async function writeLog(
  client: any,
  taskId: string,
  startedAt: Date,
  finishedAt: Date,
  status: string,
  rowsCollected: number,
  errorMessage?: string,
  storagePath?: string,
  verification?: { api_total: number; missing: number; verified: boolean; page_failures?: number }
) {
  await client.database
    .from('collect_logs')
    .insert([{
      task_id: taskId,
      status: status,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      rows_collected: rowsCollected,
      error_message: errorMessage || null,
      response_summary: storagePath ? {
        storage_path: storagePath,
        verification: verification || null,
      } : null,
    }]);
}