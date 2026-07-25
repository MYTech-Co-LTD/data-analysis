// 语义字典：指标+维度（semantic_dictionary_v）+ 指标数据源（metric_sources 合并）
// 直连 PostgREST（同 items route 模式）
import { NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  const [dictRes, srcRes] = await Promise.all([
    fetch(`${POSTGREST_URL}/semantic_dictionary_v?order=kind,code`, { headers }),
    fetch(`${POSTGREST_URL}/metric_sources`, { headers }),
  ]);
  const dictRows = await dictRes.json();
  const srcRows = await srcRes.json();
  const srcMap = new Map<string, any>((srcRows || []).map((s: any) => [s.metric_code, s]));
  const data = (dictRows || []).map((r: any) => {
    if (r.kind !== 'metric') return { ...r, source_table: null, source_column: null };
    const s: any = srcMap.get(r.code);
    return { ...r, source_table: s?.source_table ?? null, source_column: s?.source_column ?? null };
  });
  return NextResponse.json({ data });
}
