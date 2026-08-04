// web/lib/collect-wholesale.ts
// 批发销售明细采集（乐檬 nhsoft.amazon.wholesale.item.detail），照 collect-delivery.ts 模式。
// 只 3120；落 Parquet: lemeng/wholesale_detail/{company_id}/{date}/all.parquet
// 接口差异（实测）：dateFrom/dateTo（非 dtFrom）、dateType:"审核时间"、isPaging（非 paging）、branchNums:[]（空=全部销售门店）、audit:true
import crypto from 'crypto';

const BASE_URL = "https://sharef.lemengcloud.com";
const ENDPOINT_DETAIL = "/earth-gateway/amazon-report/report/center/nhsoft.amazon.wholesale.item.detail";
const REQUEST_TIMEOUT = 30000;
const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY || '';
const LEMENG_SECRET_KEY = process.env.LEMENG_SECRET_KEY || '';

function decodeCompanyId(authToken: string): string {
  try {
    const raw = authToken.startsWith('Bearer ') ? authToken.slice(7) : authToken;
    const parts = raw.split('.');
    if (parts.length < 2) return 'unknown';
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    return String(payload.company_id || 'unknown');
  } catch { return 'unknown'; }
}

function generateSignature(authToken: string, timestamp: string, nonce: string, branchNums: string, scopeIds: string, urlPath: string, bodyStr: string, secretKey: string): string {
  const signStr = authToken + timestamp + nonce + branchNums + scopeIds + secretKey + urlPath + bodyStr + secretKey;
  return crypto.createHash('sha256').update(signStr, 'utf8').digest('hex');
}
function buildHeaders(authToken: string, branchNumsStr: string, urlPath: string, bodyStr: string) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = generateSignature(authToken, timestamp, nonce, branchNumsStr, "", urlPath, bodyStr, LEMENG_SECRET_KEY);
  return {
    "Authorization": authToken, "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "x-timestamp": timestamp, "x-nonce": nonce, "x-signature": signature,
    "X-LoginBranchNum": "99", "x-branch-nums": branchNumsStr, "x-desensitization-columns": ""
  };
}

// 真实 body（实测抓包）：dateFrom/dateTo + dateType:"审核时间" + isPaging + audit + branchNums:[]（空=全部）
function buildBody(dateFrom: string, dateTo: string, offset: number, limit: number): string {
  return JSON.stringify({
    onlyShowNegativeQty: false, unitType: "常用单位", audit: true, region: [],
    branchNums: [],                                   // 空 = 全部销售门店
    dateFrom, dateTo, dateType: "审核时间",
    sellers: [], offset, limit, isPaging: true, customColumn: {}
  });
}

// 批发明细字段（snake_case）：单据/客户/门店/商品/批发量额毛利
function flattenRecords(records: any[]): any[] {
  if (records.length > 0) console.log('[collect-wholesale] 乐檬API返回字段数:', Object.keys(records[0]).length, '字段:', Object.keys(records[0]).sort().join(','));
  return records.map(r => ({
    id: r.id,
    pos_order_num: r.posOrderNum,
    pos_order_type: r.posOrderType,
    audit_time: r.auditTime,
    sale_time: r.saleTime,
    order_type: r.orderType,
    settlement_status: r.settlementStatus,
    branch_num: r.branchNum,
    client_code: r.clientCode,
    client_name: r.clientName,
    storehouse_num: r.storehouseNum,
    storehouse_name: r.storehouseName,
    item_num: r.itemNum,
    pos_item_code: r.posItemCode,
    pos_item_name: r.posItemName,
    pos_item_category: r.posItemCategory,
    pos_item_category_name: r.posItemCategoryName,
    pos_item_bar_code: r.posItemBarCode,
    department: r.department,
    spec: r.spec,
    unit: r.unit,
    lot_number: r.orderDetailLotNumber,
    wholesale_num: r.wholesaleNum,            // 批发数量
    wholesale_money: r.wholesaleMoney,        // 批发金额
    wholesale_unit_price: r.wholesaleUnitPrice,
    wholesale_cost: r.wholesaleCost,          // 成本
    wholesale_profit: r.wholesaleProfit,      // 毛利
    no_tax_money: r.noTaxMoney,
    no_tax_unit_price: r.noTaxUnitPrice,
    tax_money: r.taxMoney,
    tax_rate: r.taxRate,
    wholesale_return_num: r.wholesaleReturnNum,
    wholesale_replenishment_money: r.wholesaleReplenishmentMoney,
    order_maker: r.orderMaker,
    order_seller: r.orderSeller,
    order_auditor: r.orderAuditor,
  }));
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout); return response;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error(`Request timeout after ${timeoutMs}ms`);
    throw err;
  }
}

async function callLemengApi(urlPath: string, authToken: string, bodyStr: string, branchNumsStr: string, maxRetries = 2): Promise<{ ok: boolean; data?: any; status?: number; error?: string }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const headers = buildHeaders(authToken, branchNumsStr, urlPath, bodyStr);
    try {
      const response = await fetchWithTimeout(BASE_URL + urlPath, { method: 'POST', headers, body: bodyStr }, REQUEST_TIMEOUT);
      if (response.status === 200) {
        const data = await response.json();
        // 宽松比较 code（兼容数字 0 / 字符串 "0"；token 过期 -1）
        if (data.code == -1 && attempt < maxRetries - 1) { await new Promise(r => setTimeout(r, 2000)); continue; }
        return { ok: true, data };
      }
      const errorText = await response.text();
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
    } catch (err: any) {
      if (attempt < maxRetries - 1) { await new Promise(r => setTimeout(r, 2000)); continue; }
      return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: "Max retries exceeded" };
}

export function getYesterdayChina(): string {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  chinaTime.setDate(chinaTime.getDate() - 1);
  return chinaTime.toISOString().split('T')[0];
}
export function getTodayChina(): string {
  const now = new Date();
  const chinaTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return chinaTime.toISOString().split('T')[0];
}

export interface WholesaleCollectResult {
  records: any[]; apiTotal: number; storagePath: string; error: string; newApiTotal: number; skipped: boolean;
}
export interface WholesaleCollectOptions { mode?: 'full' | 'incremental'; watermarkLastCount?: number; }

// 仅查 count（不采集），scheduler 对账驱动用
// ⚠️ 乐檬返 code 是字符串 "0"/"-1"——必须 String 比较，严格 `=== 0` 恒 false（实测 2026-08-03）
export async function countWholesaleApi(authToken: string, branchNumsStr: string, dtFrom: string, dtTo: string): Promise<number> {
  const r = await callLemengApi(ENDPOINT_DETAIL, authToken, buildBody(dtFrom, dtTo, 0, 1), branchNumsStr);
  return (r.ok && String(r.data?.code) === '0') ? (r.data?.data?.count || 0) : -1;
}

// 单次采集：首页拿 count + 预热 → offset 分页拉全 → 落 Parquet
export async function collectWholesaleOnce(
  authToken: string,
  branchNumsStr: string,
  dateFrom: string,    // "YYYY-MM-DD HH:MM:SS"
  dateTo: string,
  limit: number = 200,
  options?: WholesaleCollectOptions,
): Promise<WholesaleCollectResult> {
  const mode = options?.mode || 'full';
  const watermarkLastCount = options?.watermarkLastCount ?? 0;
  const result: WholesaleCollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
  const companyId = decodeCompanyId(authToken);

  // 首页：拿 count + 预热
  const firstBody = buildBody(dateFrom, dateTo, 0, limit);
  const firstRes = await callLemengApi(ENDPOINT_DETAIL, authToken, firstBody, branchNumsStr);
  if (!firstRes.ok) { result.error = firstRes.error || 'first page failed'; return result; }
  if (firstRes.data?.code == -1) { result.error = `Token expired: ${firstRes.data?.msg || firstRes.data?.message}`; return result; }
  if (firstRes.data?.code != 0) { result.error = `API code=${firstRes.data?.code} msg=${firstRes.data?.msg}`; return result; }

  const data = firstRes.data?.data || {};
  result.apiTotal = data.count || 0;
  result.newApiTotal = result.apiTotal;
  const firstRecords = data.content || [];
  result.records.push(...firstRecords);
  if (result.apiTotal === 0) return result;

  if (mode === 'incremental' && result.apiTotal <= watermarkLastCount) {
    console.log(`[collect-wholesale] Incremental: apiTotal ${result.apiTotal} <= watermark ${watermarkLastCount}, skip`);
    result.skipped = true; return result;
  }

  // offset 分页
  let offset = firstRecords.length;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const randDelay = () => 800 + Math.floor(Math.random() * 1500); // 0.8~2.3秒随机间隔，模仿人避免被封锁
  let consecutiveErrors = 0;
  while (offset < result.apiTotal) {
    const bodyStr = buildBody(dateFrom, dateTo, offset, limit);
    const pr = await callLemengApi(ENDPOINT_DETAIL, authToken, bodyStr, branchNumsStr);
    if (!pr.ok || pr.data?.code != 0) {
      console.error(`[collect-wholesale] offset ${offset} error: ${pr.error || pr.data?.msg}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) { result.error = `Consecutive 3 pages failed at offset ${offset}`; break; }
      offset += limit; await sleep(randDelay()); continue;
    }
    consecutiveErrors = 0;
    const recs = pr.data?.data?.content || [];
    result.records.push(...recs);
    console.log(`[collect-wholesale] offset ${offset}/${result.apiTotal}: +${recs.length}, total ${result.records.length}`);
    offset += limit;
    if (recs.length === 0) break;
    if (offset < result.apiTotal) await sleep(randDelay());
  }

  // 落 Parquet：full 用 /transform 覆盖；incremental 用 /merge
  if (result.records.length > 0) {
    try {
      const flatRaw = flattenRecords(result.records);
      // 去重：lemeng wholesale API 分页故障会重复返回同一条业务记录（每次生成新 id），
      // 按【业务自然键】去重（与 D1 natural_key 一致）——除 id 外整行去重在字段微差/schema 漂移时失效
      const seen = new Set<string>();
      const flat = flatRaw.filter(r => {
        const key = [r.pos_order_num, r.item_num, r.client_code, r.wholesale_num, r.lot_number].join('');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (flat.length < flatRaw.length) {
        console.warn(`[collect-wholesale] 去重: ${flatRaw.length} → ${flat.length}（移除 ${flatRaw.length - flat.length} 条 lemeng 分页重复）`);
      }
      const dateStr = dateFrom.slice(0, 10).replace(/-/g, '');
      const isInc = mode === 'incremental';
      const endpoint = isInc ? '/merge' : '/transform';
      const action = isInc ? 'merge' : 'transform';
      console.log(`[collect-wholesale] DuckDB ${action}: ${flat.length} records`);
      // 按数据实际日期(audit_time→YYYYMMDD)分区写，避免回溯多天时全月数据写到 dtFrom 目录致 /compute 翻倍
      const byBizday: Record<string, any[]> = {};
      for (const r of flat) {
        const raw = String(r.audit_time || '').slice(0, 10).replace(/-/g, '') || dateStr;
        (byBizday[raw] ||= []).push(r);
      }
      let lastPath = '';
      for (const [bizday, recs] of Object.entries(byBizday)) {
        const duckRes = await fetch(`${DUCKDB_URL}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY },
          body: JSON.stringify({ records: recs, config: { date: bizday, source: 'lemeng', partition_by: [], dedupe_key: ['pos_order_num', 'item_num', 'client_code', 'wholesale_num', 'lot_number'], required_fields: ['pos_order_num', 'item_num', 'branch_num'], output_format: 'parquet', compression: 'zstd', base_path: `lemeng/wholesale_detail/${companyId}/${bizday}` } })
        });
        if (!duckRes.ok) throw new Error(`DuckDB ${action} failed (${bizday}): ${duckRes.status} ${await duckRes.text()}`);
        const dj = await duckRes.json();
        if (!dj.success) throw new Error(dj.error || `${action} failed (${bizday})`);
        if (dj.combined_file) lastPath = dj.combined_file;
        if (dj.invalid_records > 0 || dj.duplicates_removed > 0) console.warn(`[collect-wholesale] ${bizday} quality: ${dj.invalid_records} invalid, ${dj.duplicates_removed} dup`);
      }
      result.storagePath = lastPath;
      console.log(`[collect-wholesale] Parquet ${action} success: ${result.storagePath}`);
    } catch (e: any) {
      console.error(`[collect-wholesale] DuckDB ${mode} failed: ${e.message}`);
      result.error += (result.error ? '; ' : '') + `${mode === 'incremental' ? 'Merge' : 'Transform'} failed: ${e.message}`;
    }
  }
  return result;
}

export { LEMENG_SECRET_KEY };
