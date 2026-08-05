// web/lib/qa/c0-runner.ts
// C0 源API count ↔ 明细 count 执行器——route（手动）与 scheduler（每日 job / 采集后 QA）共用。
// 分毫不差：库计数必须 == 源计数（runC0 精确匹配）。
// 窗口默认 = [昨天-C0_DAYS, 昨天]（不含今天，今天未采完）；
// 采集后即时 QA 传 window 当日单日（补采集后盲区：verify 刚落的 parquet 是否与源 count 一致）。
import { countRetailApi, decodeCompanyId, getDateOffsetChina } from '@/lib/collect';
import { countDeliveryApi } from '@/lib/collect-delivery';
import { countWholesaleApi } from '@/lib/collect-wholesale';
import { runCollectBackfill } from '@/lib/collect-backfill';
import { runC0 } from '@/lib/qa/c0';
import detailSources from '@/lib/qa/config/detail-sources.json';
import type { DetailSource, CheckResult, QaTrigger } from '@/lib/qa/types';

const C0_DAYS = 7;
const MAX_RETRIES = 3;   // autoBackfill full 重采后单日收敛上限（仿 c1-runner）

export interface C0RunnerOpts {
  client: { database: any };            // InsForge SDK createClient 结果
  duck: (sql: string) => Promise<Record<string, unknown>[]>;
  runId: string;
  trigger: QaTrigger;
  checks?: string[];                    // 过滤，如 ['C0:retail']；缺省全部
  /** 窗口覆盖（ISO YYYY-MM-DD，两端含）。不传则默认 7 天回溯（昨天往前 C0_DAYS 天）。
   *  采集后即时对账传当日单日窗口（补采集后盲区）。 */
  window?: { from: string; to: string };
  /** C0 missing 自动补采（默认 false）：某源结果 status==='fail' && detail[0].verdict==='missing'
   *  时，对该源对应 collect task full 重采当日 → 单日 C0 收敛（≤3 retry，仿 c1-runner）。
   *  采集后 QA 传 true（采集刚完，missing 多数是采集遗漏，full 重采可修）。 */
  autoBackfill?: boolean;
}

/** 生成 [from, to] 之间的 ISO 日期列表（两端含）。 */
function isoDaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime()) || cur > end) return [];
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/** 单源单日 count：API count vs parquet count（三源各自目录/日期格式）。 */
async function countForDay(
  src: DetailSource,
  task: any,
  authToken: string,
  companyId: string,
  dayIso: string,
  duck: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<{ apiCount: number; libCount: number }> {
  const dayCompact = dayIso.replace(/-/g, '');
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
  return { apiCount, libCount };
}

export async function runC0Checks(opts: C0RunnerOpts): Promise<CheckResult[]> {
  const { client, duck, runId, trigger, checks, window: win, autoBackfill } = opts;
  const results: CheckResult[] = [];

  // 窗口：opts.window 优先（采集后当日单日），否则默认 7 天回溯 [昨天-(C0_DAYS-1), 昨天]
  const fromIso = win?.from ?? getDateOffsetChina(-C0_DAYS);
  const toIso = win?.to ?? getDateOffsetChina(-1);

  for (const src of detailSources as DetailSource[]) {
    // C0 只对原始三源（retail/delivery/wholesale）：item 源无 collect 任务（function_slug=''），
    // countForDay 的 if/else 会落错分支，故跳过。
    if (src.name !== 'retail' && src.name !== 'delivery' && src.name !== 'wholesale') continue;
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

        for (const dayIso of isoDaysBetween(fromIso, toIso)) {
          const checkName = `${src.name}:${companyId}:${dayIso}`;
          let counts = await countForDay(src, task, authToken, companyId, dayIso, duck);
          let r = await runC0(src, dayIso, counts.apiCount, counts.libCount);

          // C0 missing 自动补采：full 重采当日 → 单日 C0 收敛（≤3 retry，仿 c1-runner）。
          // 仅当源 count 取数正常且 verdict==='missing'（库<源）才补；dup-suspect/error 不动。
          if (autoBackfill && r.status === 'fail' && (r.detail as any[])?.[0]?.verdict === 'missing') {
            let retries = 0;
            while (r.status === 'fail' && retries < MAX_RETRIES && (r.detail as any[])?.[0]?.verdict === 'missing') {
              try {
                await runCollectBackfill(task, authToken, dayIso, dayIso);
              } catch (e) {
                console.error('[c0-runner] backfill 失败:', e instanceof Error ? e.message : e);
              }
              counts = await countForDay(src, task, authToken, companyId, dayIso, duck);
              r = await runC0(src, dayIso, counts.apiCount, counts.libCount);
              retries++;
            }
          }

          // 只落最终结果（含 backfill 收敛后的），避免同 run_id+check_name 撞 qa_logs UNIQUE 约束
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
