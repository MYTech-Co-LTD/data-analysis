// web/lib/report-center/wholesale-customer.ts
// 批发客户报表数据获取（report_wholesale_customer_gen）
// 3120 客户批发排名 + 累计占比 + 品品甜识别（数据驱动，不硬编码品牌码）
import { getClient } from "@/lib/api";

export interface WholesaleCustomerRow {
  client_code: string;
  client_name: string;
  wholesale_amount: number;
  pct: number; // 占比（0-1）
  cumulative_pct: number; // 累计占比（0-1，按金额降序累加）
  is_pinpintian: boolean; // client_brand_code 对应品品甜品牌
}

export interface WholesaleCustomerResult {
  rows: WholesaleCustomerRow[];
  pinpintianAmount: number; // 品品甜客户批发合计
  pinpintianPct: number; // 品品甜占 3120 总额比例
  total3120: number; // 3120 客户批发总额
}

/**
 * 3120（总部主账套）批发客户排名。
 * 品牌识别数据驱动：从 dim_brand 查 brand_name='品品甜' 的 system_book_code，
 * 与行的 client_brand_code 比对。不硬编码 '64188'。
 */
export async function getWholesaleCustomer(
  targetId: number
): Promise<WholesaleCustomerResult> {
  const client = await getClient();

  const { data, error } = await client.database
    .from("report_wholesale_customer_gen")
    .select(
      "client_code,client_name,wholesale_amount,client_brand_code,system_book_code"
    )
    .eq("target_id", targetId)
    .eq("system_book_code", "3120") // 3120 客户为主（3120=总部主账套）
    .order("wholesale_amount", { ascending: false });
  if (error) {
    console.error("getWholesaleCustomer: fetch failed:", error);
    return { rows: [], pinpintianAmount: 0, pinpintianPct: 0, total3120: 0 };
  }
  const arr = (data ?? []) as Array<{
    client_code: string;
    client_name: string;
    wholesale_amount: number | string | null;
    client_brand_code: string | null;
    system_book_code: string;
  }>;
  const total = arr.reduce((s, r) => s + Number(r.wholesale_amount || 0), 0);

  // 品品甜品牌码查 dim_brand（数据驱动，不硬编码）
  const { data: brands, error: bErr } = await client.database
    .from("dim_brand")
    .select("system_book_code,brand_name");
  if (bErr) {
    console.error("getWholesaleCustomer: dim_brand fetch failed:", bErr);
  }
  const pptBrand = (brands ?? []).find(
    (b: { brand_name: string; system_book_code: string }) =>
      b.brand_name === "品品甜"
  )?.system_book_code;

  let cumul = 0;
  const rows: WholesaleCustomerRow[] = arr.map((r) => {
    const amt = Number(r.wholesale_amount || 0);
    const pct = total > 0 ? amt / total : 0;
    cumul += pct;
    return {
      client_code: r.client_code,
      client_name: r.client_name,
      wholesale_amount: amt,
      pct,
      cumulative_pct: cumul,
      is_pinpintian: !!(pptBrand && r.client_brand_code === pptBrand),
    };
  });
  const pinpintianAmount = rows
    .filter((r) => r.is_pinpintian)
    .reduce((s, r) => s + r.wholesale_amount, 0);
  return {
    rows,
    pinpintianAmount,
    pinpintianPct: total > 0 ? pinpintianAmount / total : 0,
    total3120: total,
  };
}
