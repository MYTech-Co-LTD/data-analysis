// 语义层健康：A) 动态发现所有 audit 视图算 rollup diff（155 删 _audit 后空转，保留兼容）
//  A2) C3 同款 rollup pivot（report_*_gen 的 level 列动态 pivot，替代旧 _audit）
//  B) 跑 validate_semantic_registry
import { NextResponse } from 'next/server';
import { parseAuditViewNames, computeAuditStats, computeRollupDiff } from '@/lib/semantic/health';
import { C3_ROLLUP_VIEWS, buildRollupPivotSql } from '@/lib/qa/c3-runner';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;
const headers = {
  apikey: INSFORGE_API_KEY,
  Authorization: `Bearer ${INSFORGE_API_KEY}`,
  'Content-Type': 'application/json',
};

export async function GET() {
  // A: 动态发现 audit 视图（PostgREST 根 OpenAPI）
  const rootRes = await fetch(`${POSTGREST_URL}/`, { headers });
  const openapi = await rootRes.json();
  const auditViews = parseAuditViewNames(openapi);
  const audits = [];
  for (const view of auditViews) {
    const r = await fetch(`${POSTGREST_URL}/${view}?limit=1000`, { headers });
    if (!r.ok) {
      audits.push({ view, diffColumns: [], status: 'warn', totals: {}, error: `query ${r.status}` });
      continue;
    }
    const rows = await r.json();
    if (!Array.isArray(rows)) {
      audits.push({ view, diffColumns: [], status: 'warn', totals: {}, error: 'non-array response' });
      continue;
    }
    audits.push({ view, ...computeAuditStats(rows) });
  }

  // A2: rollup 自洽（C3 同款动态 pivot；155 删 _audit 后由 gen 视图 level 列 pivot 替代）。
  //     经 execute_sql RPC（SECURITY DEFINER 绕 RLS，服务身份查全量；rollup 自洽与 JWT 裁剪无关）。
  const rollups = [];
  for (const cfg of C3_ROLLUP_VIEWS) {
    for (const metric of cfg.metrics) {
      try {
        const r = await fetch(`${POSTGREST_URL}/rpc/execute_sql`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query: `SELECT to_jsonb(q) FROM (${buildRollupPivotSql(cfg.view, metric, false)}) AS q` }),
        });
        if (!r.ok) {
          rollups.push({ view: cfg.view, metric, diffColumns: [], status: 'warn', totals: {}, error: `query ${r.status}` });
          continue;
        }
        const raw = await r.json();
        const rows = (Array.isArray(raw) ? raw : []).map((x: any) =>
          x && typeof x === 'object' && 'to_jsonb' in x ? x.to_jsonb : x);
        rollups.push({ view: cfg.view, metric, ...computeRollupDiff(rows) });
      } catch (e) {
        rollups.push({ view: cfg.view, metric, diffColumns: [], status: 'warn', totals: {}, error: String(e instanceof Error ? e.message : e) });
      }
    }
  }

  // B: 配置校验（/rpc 必须直连 PostgREST，gateway 不代理）
  const vRes = await fetch(`${POSTGREST_URL}/rpc/validate_semantic_registry`, {
    method: 'POST',
    headers,
    body: '{}',
  });
  const validationsRaw = await vRes.json();
  const validations = Array.isArray(validationsRaw) ? validationsRaw : [];

  return NextResponse.json({ audits, rollups, validations });
}
