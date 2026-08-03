// web/lib/qa/c0-runner.ts
// C0 源API count ↔ 明细 count 执行器——route（手动）与 scheduler（每日 job）共用。
// 分毫不差：库计数必须 == 源计数（runC0 精确匹配）；窗口 = [昨天-(C0_DAYS-1), 昨天]（不含今天，今天未采完）。
import { countRetailApi, decodeCompanyId, getDateOffsetChina } from '@/lib/collect';
import { countDeliveryApi } from '@/lib/collect-delivery';
import { countWholesaleApi } from '@/lib/collect-wholesale';
import { runC0 } from '@/lib/qa/c0';
import detailSources from '@/lib/qa/config/detail-sources.json';
import type { DetailSource, CheckResult, QaTrigger } from '@/lib/qa/types';

const C0_DAYS = 7;

export interface C0RunnerOpts {
  client: { database: any };            // InsForge SDK createClient 结果
  duck: (sql: string) => Promise<Record<string, unknown>[]>;
  runId: string;
  trigger: QaTrigger;
  checks?: string[];                    // 过滤，如 ['C0:retail']；缺省全部
}

export async function runC0Checks(opts: C0RunnerOpts): Promise<CheckResult[]> {
  const { client, duck, runId, trigger, checks } = opts;
  const results: CheckResult[] = [];

  for (const src of detailSources as DetailSource[]) {
    if (checks && !checks.includes(`C0:${src.name}`)) continue;
    try {
      const { data: tasks } = await client.database.from('collect_tasks')
        .select('source_id,params').eq('function_slug', src.function_slug);
      if (!tasks?.length) {
        results.push({ run_id: runId, trigger, check_type: 'C0', check_name: src.name, status: 'error', diff: null, detail: [{ error: `no collect_tasks for ${src.function_slug}` }] });
        continue;
      }
      for (const task of tasks) {
        const { data: cred } = await client.database.from('auth_credentials')
          .select('credential_data').eq('source_id', task.source_id).single();
        let token = '';
        try { token = JSON.parse(cred?.credential_data || '{}').token || ''; } catch {}
        const authToken = token.startsWith('Bearer ') ? token : 'Bearer ' + token;
        let companyId = 'unknown';
        try { companyId = decodeCompanyId(authToken); } catch {}

        // 窗口 = [昨天-(C0_DAYS-1), 昨天]，不含今天（今天数据未采集完，count<api 恒误报 missing）
        for (let i = C0_DAYS; i >= 1; i--) {
          const dayIso = getDateOffsetChina(-i);
          const dayCompact = dayIso.replace(/-/g, '');
          const checkName = `${src.name}:${companyId}:${dayIso}`;
          let apiCount = -1;
          let libCount = 0;
          try {
            if (src.name === 'retail') {
              const bn: number[] = task.params?.branch_nums || [];
              apiCount = await countRetailApi(authToken, bn, bn.join(','), [dayIso, dayIso]);
              libCount = (await duck(`SELECT COUNT(*) AS c FROM read_parquet('s3://lemeng-datasource/lemeng/retail_detail/${companyId}/${dayIso}/all.parquet')`))[0]?.c as number || 0;
            } else if (src.name === 'delivery') {
              const dbn = Number(task.params?.distribution_branch_num) || 99;
              apiCount = await countDeliveryApi(authToken, dbn, String(dbn), `${dayIso} 00:00:00`, `${dayIso} 23:59:59`);
              libCount = (await duck(`SELECT COUNT(*) AS c FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/${companyId}/${dayCompact}/all.parquet')`))[0]?.c as number || 0;
            } else {
              apiCount = await countWholesaleApi(authToken, '99', `${dayIso} 00:00:00`, `${dayIso} 23:59:59`);
              libCount = (await duck(`SELECT COUNT(*) AS c FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/${companyId}/${dayCompact}/all.parquet')`))[0]?.c as number || 0;
            }
          } catch (e) { apiCount = -1; }
          const r = await runC0(src, dayIso, apiCount, libCount);
          const row: CheckResult = { ...r, run_id: runId, trigger, check_name: checkName };
          results.push(row);
          const ins = await client.database.from('qa_logs').insert([row]);
          if (ins.error) console.error('[qa] C0 qa_logs 写入失败', ins.error);
        }
      }
    } catch (e) {
      results.push({ run_id: runId, trigger, check_type: 'C0', check_name: src.name, status: 'error', diff: null, detail: [{ error: String(e instanceof Error ? e.message : e) }] });
    }
  }
  return results;
}
