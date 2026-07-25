// 品牌列表（dim_brand 单一事实源）→ 前端下拉复用
import { NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/dim_brand?order=system_book_code`, { headers });
  const data = await r.json();
  return NextResponse.json({ data });
}
