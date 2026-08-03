// web/lib/collect-delivery.ts
// 配送调出明细采集（乐檬 nhsoft.amazon.transfer.item.detail），照 collect.ts 模式。
// 只 3120；含中心→门店 + 门店间调拨（distributionBranchNums/responseBranchNums 空=全部调拨）
// 落 Parquet: lemeng/transfer_detail/{company_id}/{date}/all.parquet
import crypto from 'crypto';

const BASE_URL = "https://sharef.lemengcloud.com";
const ENDPOINT_DETAIL = "/earth-gateway/amazon-report/report/center/nhsoft.amazon.transfer.item.detail";
const REQUEST_TIMEOUT = 30000;
const DUCKDB_URL = process.env.DUCKDB_URL || 'http://duckdb:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY || '';
const LEMENG_SECRET_KEY = process.env.LEMENG_SECRET_KEY || '';

// 从 token 解 company_id（品牌），用于按品牌分区存储。同 collect.ts。
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

// 签名算法（与 collect.ts 完全一致）
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

// body 构造（实测抓到的真实结构）：驼峰，offset 分页
// 调出门店=管理中心(99)，调入门店=全选（中心→所有门店的配送调拨）
function buildBody(distributionBranch: number, dtFrom: string, dtTo: string, offset: number, limit: number): string {
  return JSON.stringify({
    branchNums: [distributionBranch], dateType: "调出日期", dtFrom, dtTo,
    distributionBranchNums: [distributionBranch], responseBranchNums: [],
    unitType: "常用单位", itemNums: [], itemLabelNums: [], itemDepartments: [], storehouseNums: [],
    filterPolicyItems: false, filterCreditNote: false, categoryCodes: [], isEnableTax: false, queryTime: false,
    managementStyles: [], taxRates: [], supplierNums: [],
    userBranchNum: distributionBranch, userStorehouseNums: [],
    dtType: "调出日期", branchNum: distributionBranch, paging: true, offset, limit
  });
}

// 扁平化：提取明细核心字段（snake_case，落 Parquet 用）。pos_order_* / 门店 / 商品 / 交易量额毛利
function flattenRecords(records: any[]): any[] {
  return records.map(r => ({
    id: r.id,
    pos_order_num: r.posOrderNum,
    pos_order_type: r.posOrderType,
    order_time: r.orderTime,
    sale_time: r.saleTime,
    state: r.state,
    distribution_branch_num: r.distributionBranchNum,
    distribution_branch_name: r.distributionBranchName,
    response_branch_num: r.responseBranchNum,
    response_branch_name: r.responseBranchName,
    response_branch_region_name: r.responseBranchRegionName,
    storehouse_num: r.storehouseNum,
    storehouse_name: r.storehouseName,
    item_num: r.itemNum,
    pos_item_code: r.posItemCode,
    pos_item_name: r.posItemName,
    item_category: r.itemCategory,
    top_category_name: r.topCategoryName,
    department: r.department,
    item_method: r.itemMethod,
    spec: r.spec,
    out_unit: r.outUnit,
    lot_number: r.lotNumber,
    out_amount: r.outAmount,            // 调出数量（拿货量）
    out_money: r.outMoney,              // 调出金额
    out_unit_price: r.outUnitPrice,
    cost_price: r.costPrice,            // 成本
    cost_unit_price: r.costUnitPrice,
    profit_money: r.profitMoney,        // 毛利
    no_tax_out_money: r.noTaxOutMoney,
    tax_money: r.taxMoney,
    base_amount: r.baseAmount,
    base_price: r.basePrice,
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
        if (String(data.code) === '-1' && attempt < maxRetries - 1) { await new Promise(r => setTimeout(r, 2000)); continue; }
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

export interface DeliveryCollectResult {
  records: any[]; apiTotal: number; storagePath: string; error: string; newApiTotal: number; skipped: boolean;
}
export interface DeliveryCollectOptions { mode?: 'full' | 'incremental'; watermarkLastCount?: number; }

// 仅查 count（不采集），scheduler 对账驱动用
export async function countDeliveryApi(authToken: string, distributionBranch: number, branchNumsStr: string, dtFrom: string, dtTo: string): Promise<number> {
  const r = await callLemengApi(ENDPOINT_DETAIL, authToken, buildBody(distributionBranch, dtFrom, dtTo, 0, 1), branchNumsStr);
  return (r.ok && r.data?.code === 0) ? (r.data?.data?.count || 0) : -1;
}

// 单次采集：首页拿 count + 预热 → offset 分页拉全 → 落 Parquet
// branchNumsStr：签名/header 用（配送中心号字符串，如 "99"）
export async function collectDeliveryOnce(
  authToken: string,
  distributionBranch: number,
  branchNumsStr: string,
  dtFrom: string,    // "YYYY-MM-DD HH:MM:SS"
  dtTo: string,
  limit: number = 200,
  options?: DeliveryCollectOptions,
): Promise<DeliveryCollectResult> {
  const mode = options?.mode || 'full';
  const watermarkLastCount = options?.watermarkLastCount ?? 0;
  const result: DeliveryCollectResult = { records: [], apiTotal: 0, storagePath: '', error: '', newApiTotal: 0, skipped: false };
  const companyId = decodeCompanyId(authToken);

  // 首页：拿 count + 预热 token
  const firstBody = buildBody(distributionBranch, dtFrom, dtTo, 0, limit);
  const firstRes = await callLemengApi(ENDPOINT_DETAIL, authToken, firstBody, branchNumsStr);
  if (!firstRes.ok) { result.error = firstRes.error || 'first page failed'; return result; }
  const code = String(firstRes.data?.code);   // 乐檬返 code 是字符串 "0"/"-1"
  if (code === '-1') { result.error = `Token expired: ${firstRes.data?.message}`; return result; }
  if (code !== '0') { result.error = `API code=${firstRes.data?.code} msg=${firstRes.data?.msg}`; return result; }

  const data = firstRes.data?.data || {};
  result.apiTotal = data.count || 0;
  result.newApiTotal = result.apiTotal;
  const firstRecords = data.content || [];
  result.records.push(...firstRecords);
  if (result.apiTotal === 0) return result;

  // 增量跳过
  if (mode === 'incremental' && result.apiTotal <= watermarkLastCount) {
    console.log(`[collect-delivery] Incremental: apiTotal ${result.apiTotal} <= watermark ${watermarkLastCount}, skip`);
    result.skipped = true; return result;
  }

  // offset 分页（从首页之后续采）
  let offset = firstRecords.length;
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const randDelay = () => 800 + Math.floor(Math.random() * 1500); // 0.8~2.3秒随机间隔，模仿人避免被封锁
  let consecutiveErrors = 0;
  while (offset < result.apiTotal) {
    const bodyStr = buildBody(distributionBranch, dtFrom, dtTo, offset, limit);
    const pr = await callLemengApi(ENDPOINT_DETAIL, authToken, bodyStr, branchNumsStr);
    if (!pr.ok || String(pr.data?.code) !== '0') {
      console.error(`[collect-delivery] offset ${offset} error: ${pr.error || pr.data?.msg}`);
      consecutiveErrors++;
      if (consecutiveErrors >= 3) { result.error = `Consecutive 3 pages failed at offset ${offset}`; break; }
      offset += limit; await sleep(randDelay()); continue;
    }
    consecutiveErrors = 0;
    const recs = pr.data?.data?.content || [];
    result.records.push(...recs);
    console.log(`[collect-delivery] offset ${offset}/${result.apiTotal}: +${recs.length}, total ${result.records.length}`);
    offset += limit;
    if (recs.length === 0) break;
    if (offset < result.apiTotal) await sleep(randDelay());
  }

  // 落 Parquet：full 用 /transform 覆盖；incremental 用 /merge
  if (result.records.length > 0) {
    try {
      const flatRaw = flattenRecords(result.records);
      // 去重：lemeng transfer API 分页故障会重复返回同一条业务记录（每次生成新 id），
      // 按【除 id 外全部字段】去重——id 是 lemeng 侧每次请求新生成的行 id，非业务键
      const seen = new Set<string>();
      const flat = flatRaw.filter(r => {
        const key = JSON.stringify(r, (k, v) => (k === 'id' ? undefined : v));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (flat.length < flatRaw.length) {
        console.warn(`[collect-delivery] 去重: ${flatRaw.length} → ${flat.length}（移除 ${flatRaw.length - flat.length} 条 lemeng 分页重复）`);
      }
      const dateStr = dtFrom.slice(0, 10).replace(/-/g, ''); // YYYYMMDD
      const isInc = mode === 'incremental';
      const endpoint = isInc ? '/merge' : '/transform';
      const action = isInc ? 'merge' : 'transform';
      console.log(`[collect-delivery] DuckDB ${action}: ${flat.length} records`);
      // 按数据实际日期(order_time→YYYYMMDD)分区写，避免回溯多天时全月数据写到 dtFrom 目录致 /compute 翻倍
      const byBizday: Record<string, any[]> = {};
      for (const r of flat) {
        const raw = String(r.order_time || '').slice(0, 10).replace(/-/g, '') || dateStr;
        (byBizday[raw] ||= []).push(r);
      }
      let lastPath = '';
      for (const [bizday, recs] of Object.entries(byBizday)) {
        const duckRes = await fetch(`${DUCKDB_URL}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY },
          body: JSON.stringify({ records: recs, config: { date: bizday, source: 'lemeng', partition_by: [], dedupe_key: ['*'], required_fields: ['pos_order_num', 'item_num', 'response_branch_num'], output_format: 'parquet', compression: 'zstd', base_path: `lemeng/transfer_detail/${companyId}/${bizday}` } })
        });
        if (!duckRes.ok) throw new Error(`DuckDB ${action} failed (${bizday}): ${duckRes.status} ${await duckRes.text()}`);
        const dj = await duckRes.json();
        if (!dj.success) throw new Error(dj.error || `${action} failed (${bizday})`);
        if (dj.combined_file) lastPath = dj.combined_file;
        if (dj.invalid_records > 0 || dj.duplicates_removed > 0) console.warn(`[collect-delivery] ${bizday} quality: ${dj.invalid_records} invalid, ${dj.duplicates_removed} dup`);
      }
      result.storagePath = lastPath;
      console.log(`[collect-delivery] Parquet ${action} success: ${result.storagePath}`);
    } catch (e: any) {
      console.error(`[collect-delivery] DuckDB ${mode} failed: ${e.message}`);
      result.error += (result.error ? '; ' : '') + `${mode === 'incremental' ? 'Merge' : 'Transform'} failed: ${e.message}`;
    }
  }
  return result;
}

export { LEMENG_SECRET_KEY };
