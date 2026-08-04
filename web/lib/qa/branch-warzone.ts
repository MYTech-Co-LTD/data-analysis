// web/lib/qa/branch-warzone.ts
// 门店战区完整性守护（C5 门店主数据）：检测「近 N 天有销售但被排除出考核战区」的门店。
// 背景：战区来自 lemeng API first_level_region.name → dim_branch.first_level_region；
//   考核判定 is_assessed_war_zone(first_level_region) 查 dim_war_zone.is_assessed（东/南/西/中=考核）。
//   源端（乐檬后台）未给新门店分区 → first_level_region 空 → 该店销售被 report_achievement_v 的
//   考核 total 行静默排除（业绩漏算）。采集对账只校验门店数≥API total，不校验战区字段，故加此守护兜底。
// fail → 企微告警（复用 qa-runner 触发入口的 failed→notifyWecom），人工去乐檬后台补区域。
// 铁律：考核战区集合数据驱动读 dim_war_zone（不硬编码）；销售阈值过滤边缘店噪音。
import { getDateOffsetChina } from '../collect';
import type { CheckResult, QaTrigger } from './types';

const LOOKBACK_DAYS = 7;           // 近 7 天销售（门店非每天都有销售，7 天更能代表"在营业"）
const SALE_ALERT_THRESHOLD = 1000; // 近 N 天销售 ≥ 此值（元）才告警——过滤配送中心/休眠店零碎销售噪音

interface StoreRow {
  system_book_code: string;
  branch_num: string;
  branch_name: string;
  war_zone: string | null;         // = dim_branch.first_level_region（branch_admin_v 别名）
  unmapped: boolean;               // first_level_region IS NULL
}

export async function runBranchWarzoneCheck(opts: {
  db: { from(t: string): any };
  runId: string;
  trigger: QaTrigger;
  checks?: string[];
}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const { db, runId, trigger, checks } = opts;
  // 支持定向触发/排除（check_name 前缀匹配，与 item-master 同款）
  if (checks && !checks.some((c) => c.startsWith("branch_warzone"))) return results;

  const checkType = "C5";
  const checkName = "branch_warzone";

  try {
    // 1. 考核战区集合（数据驱动，与 dim_war_zone.is_assessed 单一事实源一致）
    const { data: wzRows } = await db.from("dim_war_zone").select("war_zone").eq("is_assessed", true);
    const assessedZones = new Set(((wzRows ?? []) as { war_zone: string }[]).map((r) => r.war_zone));

    // 2. 全部门店战区映射（branch_admin_v 已过滤 is_active=true；war_zone 即 first_level_region）
    const { data: storeRows } = await db.from("branch_admin_v")
      .select("system_book_code,branch_num,branch_name,war_zone,unmapped");
    const storeMap = new Map<string, StoreRow>();
    for (const s of (storeRows ?? []) as StoreRow[]) {
      storeMap.set(`${s.system_book_code}|${s.branch_num}`, s);
    }

    // 3. 近 N 天销售按门店聚合（PostgREST .sum() 隐式 group by 非聚合列）
    const dayFrom = getDateOffsetChina(-LOOKBACK_DAYS);
    const { data: saleRows } = await db.from("report_daily_sales")
      .select("system_book_code,branch_num,total_sale.sum()")
      .gte("biz_date", dayFrom);
    const sales = ((saleRows ?? []) as Record<string, unknown>[]).map((r) => ({
      system_book_code: String(r.system_book_code ?? ""),
      branch_num: String(r.branch_num ?? ""),
      total_sale: Number(r.total_sale ?? r.sum ?? 0),
    }));

    // 4. 找「有销售 + 被排除出考核」的门店
    const excluded: { branch_number: string; branch_name: string; war_zone: string | null; sale: number; unmapped: boolean }[] = [];
    for (const sale of sales) {
      if (sale.total_sale <= 0) continue;
      const s = storeMap.get(`${sale.system_book_code}|${sale.branch_num}`);
      if (!s) continue; // 销售表有、门店维表无（属另一类漏采，不在本检查范围）
      const isAssessed = s.war_zone ? assessedZones.has(s.war_zone) : false;
      if (isAssessed) continue; // 考核店，正常
      // 非考核：first_level_region 空 或 不在考核战区集合 → 销售被 is_assessed_war_zone 排除
      excluded.push({
        branch_number: `${sale.system_book_code}-${sale.branch_num}`,
        branch_name: s.branch_name,
        war_zone: s.war_zone,
        sale: Math.round(sale.total_sale),
        unmapped: !!s.unmapped,
      });
    }

    // 5. 阈值过滤：销售超阈值的非考核店才告警（过滤配送中心/休眠店零碎销售）
    const alert = excluded.filter((e) => e.sale >= SALE_ALERT_THRESHOLD).sort((a, b) => b.sale - a.sale);

    if (alert.length) {
      results.push({
        run_id: runId, trigger, check_type: checkType, check_name: checkName,
        status: "fail", diff: alert.length,
        detail: alert.slice(0, 20).map((e) => ({
          branch: e.branch_number, name: e.branch_name,
          war_zone: e.war_zone || "(空-未映射)", sale_7d: e.sale,
          severity: e.unmapped ? "高危(完全无战区,销售被排除)" : "非考核战区",
        })),
      });
    } else {
      // PASS：无超阈值漏划店。detail 附带小额非考核店一览（informational，供人审视广西大区等合理非考核）
      results.push({
        run_id: runId, trigger, check_type: checkType, check_name: checkName,
        status: "pass", diff: 0,
        detail: excluded.length ? excluded.slice(0, 10).map((e) => ({
          branch: e.branch_number, name: e.branch_name,
          war_zone: e.war_zone || "(空)", sale_7d: e.sale,
        })) : null,
      });
    }
  } catch (e) {
    results.push({
      run_id: runId, trigger, check_type: checkType, check_name: checkName,
      status: "error", diff: null, detail: [{ error: String(e instanceof Error ? e.message : e) }],
    });
  }
  return results;
}
