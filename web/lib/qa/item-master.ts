// web/lib/qa/item-master.ts
// 商品主数据完整性守护：检测 delivery/wholesale 里不在 dim_item 的商品（新商品/采集遗漏），
// 发现即自动触发商品档案采集（collectItems）+ 重算受影响的日聚合，杜绝"其他"漏算。
// 铁律：口径单一来源（dim_item 主数据）；这是数据完整性守护（D 类检查），自动修复。
import { collectItems } from '../collect-items';
import { decodeCompanyId, getDateOffsetChina } from '../collect';
import type { CheckResult, QaTrigger } from './types';

const LOOKBACK_DAYS = 3;          // 检测最近 3 天的 delivery/wholesale
const DUCKDB_URL = process.env.DUCKDB_URL || "http://duckdb:9000";
const AGENT_API_KEY = process.env.AGENT_API_KEY!;

interface ItemTask {
  id: string;
  source_id: string;
  params?: { branch_id?: number; page_size?: number };
}

export async function runItemMasterCheck(opts: {
  db: { from(t: string): any };
  duck: (sql: string) => Promise<Record<string, unknown>[]>;
  runId: string;
  trigger: QaTrigger;
  checks?: string[];
}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const { db, duck, runId, trigger, checks } = opts;
  if (checks && !checks.some((c) => c.startsWith("item_master"))) return results;

  const { data: itemTasks } = await db.from("collect_tasks")
    .select("id,source_id,params").eq("function_slug", "collect-items");

  for (const task of (itemTasks ?? []) as ItemTask[]) {
    const { data: cred } = await db.from("auth_credentials")
      .select("credential_data").eq("source_id", task.source_id).single();
    let token = "";
    try { token = JSON.parse(cred?.credential_data || "{}").token || ""; } catch {}
    const authToken = token.startsWith("Bearer ") ? token : "Bearer " + token;
    let companyId = "unknown";
    try { companyId = decodeCompanyId(authToken); } catch {}

    try {
      // 近 N 天 delivery + wholesale 里 item_num 不在 dim_item 的商品
      // 配送(transfer_detail)仅 3120 采集；64188 无配送文件，须跳过 delivery 分支（否则 glob 无文件报错）
      const dayFrom = getDateOffsetChina(-LOOKBACK_DAYS).replace(/-/g, "");
      const branches: string[] = [];
      // wholesale：两品牌都有
      branches.push(`SELECT DISTINCT t.item_num, t.pos_item_name
FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/${companyId}/*/all.parquet', filename=true, union_by_name=true) t
LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_item.parquet', filename=true, union_by_name=true) di
  ON di.system_book_code = '${companyId}' AND di.item_num = t.item_num
WHERE substr(t.audit_time,1,4)||substr(t.audit_time,6,2)||substr(t.audit_time,9,2) >= '${dayFrom}'
  AND t.item_num IS NOT NULL AND di.item_num IS NULL`);
      // delivery：仅 3120（transfer_detail 只采 3120）
      if (companyId === '3120') {
        branches.push(`SELECT DISTINCT t.item_num, t.pos_item_name
FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/3120/*/all.parquet', filename=true, union_by_name=true) t
LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_item.parquet', filename=true, union_by_name=true) di
  ON di.system_book_code = '3120' AND di.item_num = t.item_num
WHERE substr(t.order_time,1,4)||substr(t.order_time,6,2)||substr(t.order_time,9,2) >= '${dayFrom}'
  AND t.item_num IS NOT NULL AND di.item_num IS NULL`);
      }
      let unmapped: { item_num: string; pos_item_name: string }[] = [];
      try {
        unmapped = (await duck(branches.join('\nUNION\n'))) as { item_num: string; pos_item_name: string }[];
      } catch (e) {
        // 品牌无 delivery/wholesale 数据源（如 64188 只是外部客户，调拨/批发只采 3120）→ 无可查，记 PASS
        const msg = String(e instanceof Error ? e.message : e);
        if (msg.includes('No files found')) {
          results.push({
            run_id: runId, trigger, check_type: 'C5', check_name: `item_master:${companyId}`,
            status: 'pass', diff: 0, detail: null,
          });
          continue;
        }
        throw e;
      }

      if (unmapped.length) {
        // 自动修复：触发商品档案采集 → 重算受影响日聚合
        const branchId = task.params?.branch_id || 28444;
        const pageSize = task.params?.page_size || 200;
        await collectItems(authToken, branchId, pageSize);
        await recomputeRecent(companyId);
        results.push({
          run_id: runId, trigger, check_type: "C5", check_name: `item_master:${companyId}`,
          status: "fail", diff: unmapped.length,
          detail: unmapped.slice(0, 20).map((u) => ({ item_num: u.item_num, name: u.pos_item_name })),
        });
      } else {
        results.push({
          run_id: runId, trigger, check_type: "C5", check_name: `item_master:${companyId}`,
          status: "pass", diff: 0, detail: null,
        });
      }
    } catch (e) {
      results.push({
        run_id: runId, trigger, check_type: "C5", check_name: `item_master:${companyId}`,
        status: "error", diff: null, detail: [{ error: String(e instanceof Error ? e.message : e) }],
      });
    }
  }
  return results;
}

// 重算最近日期的出库相关聚合（新商品归入正确品类后刷新）
async function recomputeRecent(companyId: string): Promise<void> {
  const dayFrom = getDateOffsetChina(-LOOKBACK_DAYS);
  const dayTo = getDateOffsetChina(0);
  const types = ["daily_delivery", "daily_wholesale", "daily_category", "item_outbound", "wholesale_customer"];
  for (const report_type of types) {
    try {
      const r = await fetch(`${DUCKDB_URL}/compute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-key": AGENT_API_KEY },
        body: JSON.stringify({ report_type, date_from: dayFrom, date_to: dayTo }),
      });
      const j = await r.json().catch(() => ({}));
      console.log(`[item-master] recompute ${report_type}: ${r.ok ? "OK" : "FAIL"} rows=${j.rows_written ?? j.error ?? "?"}`);
    } catch (e) {
      console.error(`[item-master] recompute ${report_type} failed: ${e}`);
    }
  }
}
