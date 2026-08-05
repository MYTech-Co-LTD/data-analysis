// web/lib/report-center/wholesale-daily.ts
// 外部批发按日时序数据获取
// 视图 report_wholesale_daily_gen：按 biz_date 聚合的外部批发（wholesale_ext，system_book_code='3120'=熊喵除品品甜外的批发客户）
// 品牌语义：3120=熊喵鲜生、64188=品品甜；wholesale_ext 排除品品甜（64188），仅 3120 外部批发客户
// 口径源自语义层生成器
// 脱敏：profit/margin 受 request.jwt.claims.can_see_cost 控制，无成本权限时视图返 NULL（非 0，前端自行处理）
// margin 为 round(x,4) 即 0-1 小数（0.1234 = 12.34%），amount=0 时 NULLIF 致 margin NULL
//
// F1.1（前端数据准确性守护 P0）：返 GetterResult<WholesaleDailyRow> / GetterResult<WholesaleDailyCustomerRow>，
// 吞错改 status='error'。保留 closed 分支 "有快照用快照、无快照 fall-through live" 行为，select 字段不变。
import { getClient } from "@/lib/api";
import { wrapError } from "@/lib/error";
import { okResult, errorResult, type GetterResult } from "./types";
import { getSnapshotRows } from "./target-snapshot";

export interface WholesaleDailyRow {
  target_id: number;
  biz_date: string;                     // YYYY-MM-DD
  wholesale_ext_amount: number;         // 外部批发金额
  wholesale_ext_profit: number | null;  // 外部批发毛利（无成本权限时 NULL）
  wholesale_ext_margin: number | null;   // 毛利率 0-1（round 4 位，无成本权限或金额=0 时 NULL）
}

export async function getWholesaleDaily(
  targetId: number,
  closed?: boolean,
): Promise<GetterResult<WholesaleDailyRow>> {
  // 已定格目标：读快照
  if (closed) {
    try {
      const snap = await getSnapshotRows(targetId, "wholesale_daily");
      if (snap.status === "ok") {
        return okResult(
          (snap.rows as WholesaleDailyRow[]).sort((a, b) =>
            String(a.biz_date).localeCompare(String(b.biz_date))
          )
        );
      }
      // snap.status !== 'ok'：保持原 fall-through 行为（无快照即查 live）
    } catch (e) {
      console.error("wholesale_daily snapshot:", e);
      return errorResult<WholesaleDailyRow>([], wrapError(e));
    }
  }

  try {
    const client = await getClient();
    const { data, error } = await client.database
      .from("report_wholesale_daily_gen")
      .select("*")
      .eq("target_id", targetId)
      .order("biz_date", { ascending: true });

    if (error) throw error;
    return okResult((data ?? []) as WholesaleDailyRow[]);
  } catch (e) {
    console.error("getWholesaleDaily: fetch failed:", e);
    return errorResult<WholesaleDailyRow>([], wrapError(e));
  }
}

// 双 grain 视图 report_wholesale_daily_customer_gen：每行=该天该客户
// 列：target_id, client_code, biz_date, client_name, wholesale_ext_customer_*
// 脱敏：profit/margin 无成本权限时 NULL；margin 为 0-1 小数（round 4 位）
export interface WholesaleDailyCustomerRow {
  client_code: string;
  client_name: string;
  wholesale_ext_customer_amount: number;
  wholesale_ext_customer_profit: number | null;  // 脱敏 null
  wholesale_ext_customer_margin: number | null;    // 0-1 小数，脱敏 null
}

export async function getWholesaleDailyCustomers(
  targetId: number,
  date: string,
): Promise<GetterResult<WholesaleDailyCustomerRow>> {
  try {
    const client = await getClient();
    const { data, error } = await client.database
      .from("report_wholesale_daily_customer_gen")
      .select(
        "client_code,client_name,wholesale_ext_customer_amount,wholesale_ext_customer_profit,wholesale_ext_customer_margin",
      )
      .eq("target_id", targetId)
      .eq("biz_date", date)
      .order("wholesale_ext_customer_amount", { ascending: false });

    if (error) throw error;
    return okResult((data ?? []) as WholesaleDailyCustomerRow[]);
  } catch (e) {
    console.error("getWholesaleDailyCustomers: fetch failed:", e);
    return errorResult<WholesaleDailyCustomerRow>([], wrapError(e));
  }
}
