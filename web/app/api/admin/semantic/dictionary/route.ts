// 语义字典：指标+维度 + 数据源双链
//   metric_registry.fact_table/value_column = 明细源头（口径源头）
//   metric_sources.source_table/source_column = 聚合取数（实际查的预聚合表）
import { NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  const [dictRes, srcRes, regRes] = await Promise.all([
    fetch(`${POSTGREST_URL}/semantic_dictionary_v?order=kind,code`, { headers }),
    fetch(`${POSTGREST_URL}/metric_sources`, { headers }),
    fetch(`${POSTGREST_URL}/metric_registry?select=metric_code,fact_table,value_column`, { headers }),
  ]);
  const dictRows = await dictRes.json();
  const srcRows = await srcRes.json();
  const regRows = await regRes.json();
  const srcMap = new Map<string, any>((srcRows || []).map((s: any) => [s.metric_code, s]));
  const regMap = new Map<string, any>((regRows || []).map((r: any) => [r.metric_code, r]));
  const data = (dictRows || []).map((r: any) => {
    if (r.kind !== 'metric') return { ...r, fact_table: null, value_column: null, source_table: null, source_column: null };
    const reg: any = regMap.get(r.code);
    const s: any = srcMap.get(r.code);
    return {
      ...r,
      fact_table: reg?.fact_table ?? null,
      value_column: reg?.value_column ?? null,
      source_table: s?.source_table ?? null,
      source_column: s?.source_column ?? null,
    };
  });
  return NextResponse.json({ data });
}
