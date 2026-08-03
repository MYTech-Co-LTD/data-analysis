// web/app/api/admin/qa-run/route.ts
// 手动/外部触发 QA 运行器（D1/D2/C2 + C0 双向 count），记 qa_logs + 企微告警
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@insforge/sdk';
import { requireAdmin } from '@/lib/admin-api-auth';
import { runQaChecks } from '@/lib/qa-runner';
import { runC0 } from '@/lib/qa/c0';
import { duckQuery } from '@/lib/qa/duck';
import { notifyWecom } from '@/lib/notify';
import { countRetailApi, decodeCompanyId } from '@/lib/collect';
import { countDeliveryApi } from '@/lib/collect-delivery';
import { countWholesaleApi } from '@/lib/collect-wholesale';
import detailSources from '../../../../../services/semantic-generator/src/detail-sources.json';
import type { DetailSource, CheckResult } from '@/lib/qa/types';

const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY!;
const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const C0_DAYS = 7;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const checksParam = url.searchParams.get('check');
  const checks = checksParam ? checksParam.split(',') : undefined;
  const trigger = (url.searchParams.get('trigger') || 'manual') as 'cron' | 'collect' | 'deploy' | 'manual';
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const client = createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
  const db = {
    rpc: (fn: string, body: Record<string, unknown>) => fetch(`${INSFORGE_API_BASE}/rpc/${fn}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}` }, body: JSON.stringify(body),
    }).then((r) => r.json()),
    from: (t: string) => client.database.from(t),
  } as any;
  const duck = (sql: string) => duckQuery(DUCKDB_URL, AGENT_API_KEY, sql);

  const results: CheckResult[] = await runQaChecks({ runId, trigger, db, duck, checks });

  // C0 双向 count（需 token + 源 API，仅 web 上下文可跑）
  for (const src of detailSources as DetailSource[]) {
    if (checks && !checks.includes(`C0:${src.name}`)) continue;
    try {
      const { data: task } = await client.database.from('collect_tasks')
        .select('source_id,params').eq('function_slug', src.function_slug).single();
      const { data: cred } = await client.database.from('auth_credentials')
        .select('credential_data').eq('source_id', task?.source_id).single();
      let token = '';
      try { token = JSON.parse(cred?.credential_data || '{}').token; } catch {}
      const authToken = token.startsWith('Bearer ') ? token : 'Bearer ' + token;

      for (let i = C0_DAYS - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dayIso = d.toISOString().slice(0, 10);
        const dayCompact = dayIso.replace(/-/g, '');
        let apiCount = -1;
        let libCount = 0;
        try {
          const companyId = decodeCompanyId(authToken);
          if (src.name === 'retail') {
            const bn: number[] = task?.params?.branch_nums || [];
            apiCount = await countRetailApi(authToken, bn, bn.join(','), [dayIso, dayIso]);
            libCount = (await duck(`SELECT COUNT(*) AS c FROM read_parquet('s3://lemeng-datasource/lemeng/retail_detail/${companyId}/${dayIso}/all.parquet')`))[0]?.c as number || 0;
          } else if (src.name === 'delivery') {
            const dbn = Number(task?.params?.distribution_branch_num) || 99;
            apiCount = await countDeliveryApi(authToken, dbn, String(dbn), `${dayIso} 00:00:00`, `${dayIso} 23:59:59`);
            libCount = (await duck(`SELECT COUNT(*) AS c FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/${companyId}/${dayCompact}/all.parquet')`))[0]?.c as number || 0;
          } else {
            apiCount = await countWholesaleApi(authToken, '99', `${dayIso} 00:00:00`, `${dayIso} 23:59:59`);
            libCount = (await duck(`SELECT COUNT(*) AS c FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/${companyId}/${dayCompact}/all.parquet')`))[0]?.c as number || 0;
          }
        } catch (e) { apiCount = -1; }
        const r = await runC0(src, dayIso, apiCount, libCount);
        results.push({ ...r, run_id: runId, trigger, check_name: src.name });
        await client.database.from('qa_logs').insert([{ ...r, run_id: runId, trigger, check_name: src.name }]).then((x) => x.error && console.error('[qa-run] qa_logs 写入失败', x.error));
      }
    } catch (e) {
      results.push({ run_id: runId, trigger, check_type: 'C0', check_name: src.name, status: 'error', diff: null, detail: [{ error: String(e instanceof Error ? e.message : e) }] });
    }
  }

  const failed = results.filter((r) => r.status !== 'pass');
  if (failed.length) {
    await notifyWecom('⚠️ 数据质量巡检异常', `${failed.length}/${results.length} 项失败:\n${failed.slice(0, 15).map((r) => `${r.check_type}:${r.check_name} ${r.status} diff=${r.diff}`).join('\n')}`).catch(() => {});
  } else {
    await notifyWecom('✅ 数据质量巡检通过', `${results.length} 项全部对齐`).catch(() => {});
  }
  return NextResponse.json({ run_id: runId, total: results.length, failed_count: failed.length, results });
}
