// web/lib/report-center/wholesale-daily.ts
// 外部批发按日时序数据获取
// 视图 report_wholesale_daily_gen：按 biz_date 聚合的外部批发（wholesale_ext，system_book_code='3120'=熊喵除品品甜外的批发客户）
// 品牌语义：3120=熊喵鲜生、64188=品品甜；wholesale_ext 排除品品甜（64188），仅 3120 外部批发客户
// 口径源自语义层生成器
// 脱敏：profit/margin 受 request.jwt.claims.can_see_cost 控制，无成本权限时视图返 NULL（非 0，前端自行处理）
// margin 为 round(x,4) 即 0-1 小数（0.1234 = 12.34%），amount=0 时 NULLIF 致 margin NULL
import { getClient } from "@/lib/api";

export interface WholesaleDailyRow {
  target_id: number;
  biz_date: string;                     // YYYY-MM-DD
  wholesale_ext_amount: number;         // 外部批发金额
  wholesale_ext_profit: number | null;  // 外部批发毛利（无成本权限时 NULL）
  wholesale_ext_margin: number | null;   // 毛利率 0-1（round 4 位，无成本权限或金额=0 时 NULL）
}

export async function getWholesaleDaily(
  targetId: number,
): Promise<WholesaleDailyRow[]> {
  const client = await getClient();

  const { data, error } = await client.database
    .from("report_wholesale_daily_gen")
    .select("*")
    .eq("target_id", targetId)
    .order("biz_date", { ascending: true });

  if (error) {
    console.error("getWholesaleDaily: fetch failed:", error);
    return [];
  }

  return (data ?? []) as WholesaleDailyRow[];
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
): Promise<WholesaleDailyCustomerRow[]> {
  const client = await getClient();

  const { data, error } = await client.database
    .from("report_wholesale_daily_customer_gen")
    .select(
      "client_code,client_name,wholesale_ext_customer_amount,wholesale_ext_customer_profit,wholesale_ext_customer_margin",
    )
    .eq("target_id", targetId)
    .eq("biz_date", date)
    .order("wholesale_ext_customer_amount", { ascending: false });

  if (error) {
    console.error("getWholesaleDailyCustomers: fetch failed:", error);
    return [];
  }

  return (data ?? []) as WholesaleDailyCustomerRow[];
}
