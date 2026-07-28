// web/app/api/admin/targets/template/route.ts
// 目标分解模板（Excel）：GET 生成 .xlsx 模板（含参考总目标行）；POST 解析上传的 .xlsx 返行
import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

const POSTGREST_URL = process.env.POSTGREST_URL || "http://postgrest:3000";
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: INSFORGE_API_KEY, Authorization: `Bearer ${INSFORGE_API_KEY}`, 'Content-Type': 'application/json' };

const METRIC_NAME: Record<string, string> = { sale: '门店零售', delivery: '门店配送', outbound_amt: '总仓出库金额', outbound_profit: '总仓出库毛利' };
const CODE: Record<string, string> = Object.fromEntries(Object.entries(METRIC_NAME).map(([k, v]) => [v, k]));

// GET 模板（.xlsx：第1行参考总目标，第2行表头，第3+行门店明细）
export async function GET(req: NextRequest) {
  const pid = req.nextUrl.searchParams.get('parent_id');
  const r = await fetch(`${POSTGREST_URL}/rpc/get_breakdown`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) });
  const rows = await r.json();
  const b = await fetch(`${POSTGREST_URL}/rpc/check_breakdown_balance`, { method: 'POST', headers, body: JSON.stringify({ p_parent_id: Number(pid) }) });
  const balance = await b.json();

  // 门店分解模板只含门店指标 sale/delivery（出库金额/毛利是总部品类维度，不在门店分解）
  const metrics: string[] = ['sale', 'delivery'];
  // get_breakdown 返 {warZoneRows, regionRows, storeRows}，模板用门店行
  const stores: any[] = rows?.storeRows || [];

  // 第1行：参考-总目标（前6格留空，后接各指标总目标）
  const refRow = ['参考-总目标', '', '', '', '', '', ...metrics.map(m => (balance as any)?.[m]?.total ?? '')];
  // 第2行：表头（门店键=branch_number，全局唯一，用于导入回匹配）
  const headRow = ['战区', '二级区域', '分组', '门店号', '门店名', '门店键', ...metrics.map(m => METRIC_NAME[m] || m)];
  // 第3+行：门店明细
  const dataRows = stores.map((x: any) => [x.war_zone || '', x.region_l2 || '', x.group || '', x.branch_num, x.branch_name, x.branch_number || '', ...metrics.map(m => x.metrics?.[m] ?? '')]);

  const ws = XLSX.utils.aoa_to_sheet([refRow, headRow, ...dataRows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '分解');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="target-breakdown.xlsx"',
    },
  });
}

// POST 上传 .xlsx → 解析返行（不直接存库，前端核对后点保存分解）
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ error: '未提供文件' }, { status: 400 });

  const ab = await file.arrayBuffer();
  const wb = XLSX.read(ab);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];

  // 定位表头行（含"门店号"）
  let headIdx = -1;
  for (let i = 0; i < aoa.length; i++) {
    if (aoa[i]?.some(c => String(c).trim() === '门店号')) { headIdx = i; break; }
  }
  if (headIdx < 0) return NextResponse.json({ error: '未找到表头行（需含"门店号"）' }, { status: 400 });
  const head = aoa[headIdx].map(c => String(c).trim());

  const branchCol = head.indexOf('门店号');
  const bnKeyCol = head.indexOf('门店键'); // branch_number（全局唯一门店键）
  const metricCols: { col: number; code: string }[] = [];
  head.forEach((h, i) => {
    const code = CODE[h];
    if (code) metricCols.push({ col: i, code });
  });

  const out: { branch_num: string; branch_number: string; metrics: Record<string, string> }[] = [];
  for (let i = headIdx + 1; i < aoa.length; i++) {
    const row = aoa[i] || [];
    const bn = row[branchCol];
    if (bn === undefined || bn === null || String(bn).trim() === '') continue;
    const branch_num = String(bn).trim();
    if (!/^\d+$/.test(branch_num)) continue; // 跳过非门店号行（如参考总目标行尾）
    const branch_number = bnKeyCol >= 0 ? String(row[bnKeyCol] ?? '').trim() : '';
    const metrics: Record<string, string> = {};
    for (const { col, code } of metricCols) {
      const cell = row[col];
      if (cell !== undefined && cell !== null && String(cell).trim() !== '') metrics[code] = String(cell).trim();
    }
    out.push({ branch_num, branch_number, metrics });
  }

  return NextResponse.json({ rows: out, count: out.length });
}
