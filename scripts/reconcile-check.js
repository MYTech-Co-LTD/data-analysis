#!/usr/bin/env node
/**
 * 明细(parquet via duckdb) vs 聚合(pg report_daily_*) 对账校验
 * 抓 stale / 丢数据 / glob 误匹配（这次 delivery []stale、retail 8位legacy 翻倍都属此类）
 *
 * 对账三表：retail / delivery / wholesale，逐天逐品牌比对 amount+profit
 * 用法：
 *   DATABASE_URL=postgresql://postgres:PWD@postgres:5432/insforge \
 *   DUCKDB_URL=http://localhost:9000 AGENT_API_KEY=xxx \
 *   node scripts/reconcile-check.js [天数默认7]
 *
 * 退出码：0=全一致  1=有差异(>0.01)
 * 集成：采集后定时跑（如每日 09:00），exit 1 接告警
 */
const path = require('path');
let _pg;
try { _pg = require(path.join(__dirname, '..', 'services', 'node_modules', 'pg')); }
catch { _pg = require(path.join(__dirname, '..', 'node_modules', 'pg')); }
const { Client } = _pg;

const DUCKDB_URL = process.env.DUCKDB_URL || 'http://localhost:9000';
const AGENT_API_KEY = process.env.AGENT_API_KEY;
const DAYS = parseInt(process.argv[2] || '7', 10);
const TOLERANCE = 0.01; // 元，差 > 此值告警

if (!AGENT_API_KEY) {
  console.error('Missing AGENT_API_KEY');
  process.exit(2);
}

const S3 = 's3://lemeng-datasource/lemeng';
const dateCompact = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

async function duck(sql) {
  const r = await fetch(`${DUCKDB_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-key': AGENT_API_KEY },
    body: JSON.stringify({ sql }),
  });
  const j = await r.json();
  if (!j.success) throw new Error('duckdb: ' + j.error);
  return j.data;
}

// 明细查询（duckdb，严格 glob 避 legacy）：返回 [{sbc,bizday,amt,profit}]
const DETAIL_QUERIES = {
  retail: (from, to) => `SELECT regexp_extract(filename,'retail_detail/([0-9]+)/',1) sbc, order_detail_bizday bizday,
      ROUND(SUM(CAST(sale_money AS DECIMAL(14,2))),2) amt, ROUND(SUM(CAST(profit AS DECIMAL(14,2))),2) profit
    FROM read_parquet('${S3}/retail_detail/*/*-*-*/all.parquet', filename=true)
    WHERE order_detail_bizday BETWEEN '${from}' AND '${to}' GROUP BY 1,2`,
  delivery: (from, to) => `SELECT '3120' sbc, substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) bizday,
      ROUND(SUM(CAST(out_money AS DECIMAL(14,2))),2) amt, ROUND(SUM(CAST(profit_money AS DECIMAL(14,2))),2) profit
    FROM read_parquet('${S3}/transfer_detail/**/all.parquet')
    WHERE substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) BETWEEN '${from}' AND '${to}' GROUP BY 1,2`,
  wholesale: (from, to) => `SELECT CASE WHEN db.branch_num IS NOT NULL THEN '64188' ELSE regexp_extract(d.filename,'wholesale_detail/([0-9]+)/',1) END sbc,
      substr(d.audit_time,1,4)||substr(d.audit_time,6,2)||substr(d.audit_time,9,2) bizday,
      ROUND(SUM(CAST(d.wholesale_money AS DECIMAL(14,2))),2) amt, ROUND(SUM(CAST(d.wholesale_profit AS DECIMAL(14,2))),2) profit
    FROM read_parquet('${S3}/wholesale_detail/**/all.parquet', filename=true) d
    LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_branch.parquet') db ON db.system_book_code='64188' AND db.branch_name=d.client_name
    WHERE substr(d.audit_time,1,4)||substr(d.audit_time,6,2)||substr(d.audit_time,9,2) BETWEEN '${from}' AND '${to}' GROUP BY 1,2`,
};

// 聚合查询（pg）：返回 [{sbc,bizday,amt,profit}]，范围与明细严格对齐(fromC~toC)
const AGG_QUERIES = {
  retail: (from, to) => `SELECT system_book_code sbc, to_char(biz_date,'YYYYMMDD') bizday,
      ROUND(SUM(total_sale),2) amt, ROUND(SUM(total_profit),2) profit
    FROM report_daily_sales WHERE to_char(biz_date,'YYYYMMDD') BETWEEN '${from}' AND '${to}' GROUP BY 1,2`,
  delivery: (from, to) => `SELECT system_book_code sbc, to_char(biz_date,'YYYYMMDD') bizday,
      ROUND(SUM(out_money),2) amt, ROUND(SUM(profit_money),2) profit
    FROM report_daily_delivery WHERE to_char(biz_date,'YYYYMMDD') BETWEEN '${from}' AND '${to}' GROUP BY 1,2`,
  wholesale: (from, to) => `SELECT system_book_code sbc, to_char(biz_date,'YYYYMMDD') bizday,
      ROUND(SUM(wholesale_money),2) amt, ROUND(SUM(wholesale_profit),2) profit
    FROM report_daily_wholesale WHERE to_char(biz_date,'YYYYMMDD') BETWEEN '${from}' AND '${to}' GROUP BY 1,2`,
};

(async () => {
  const today = new Date();
  const from = new Date(today.getTime() - (DAYS - 1) * 86400000);
  const fromC = dateCompact(from), toC = dateCompact(today);
  console.log(`[reconcile] 对账 ${fromC} ~ ${toC}（${DAYS}天），容差 ${TOLERANCE}元`);

  const pg = process.env.DATABASE_URL
    ? new Client({ connectionString: process.env.DATABASE_URL })
    : new Client({ host: process.env.PG_HOST || 'postgres', port: process.env.PG_PORT || 5432, database: process.env.PG_DATABASE || 'insforge', user: process.env.PG_USER || 'postgres', password: process.env.PG_PASSWORD || '' });
  await pg.connect();

  let bad = 0;
  for (const tbl of Object.keys(AGG_QUERIES)) {
    const [detail, aggRes] = await Promise.all([
      duck(DETAIL_QUERIES[tbl](fromC, toC)),
      pg.query(AGG_QUERIES[tbl](fromC, toC)),
    ]);
    const agg = aggRes.rows.map(r => ({ ...r, amt: parseFloat(r.amt), profit: parseFloat(r.profit) }));
    const dmap = new Map(detail.map(r => [`${r.sbc}|${r.bizday}`, r]));
    const amap = new Map(agg.map(r => [`${r.sbc}|${r.bizday}`, r]));
    const keys = new Set([...dmap.keys(), ...amap.keys()]);

    let tblBad = 0;
    const lines = [];
    for (const k of [...keys].sort()) {
      const d = dmap.get(k), a = amap.get(k);
      const dAmt = parseFloat(d?.amt || 0), aAmt = parseFloat(a?.amt || 0);
      const dPft = parseFloat(d?.profit || 0), aPft = parseFloat(a?.profit || 0);
      const diffAmt = Math.round((dAmt - aAmt) * 100) / 100;
      const diffPft = Math.round((dPft - aPft) * 100) / 100;
      if (Math.abs(diffAmt) > TOLERANCE || Math.abs(diffPft) > TOLERANCE) {
        tblBad++; bad++;
        lines.push(`  ✗ ${k}  amt 明细${dAmt}/聚合${aAmt}(diff ${diffAmt})  profit 明细${dPft}/聚合${aPft}(diff ${diffPft})`);
      }
    }
    console.log(`[${tbl}] ${tblBad === 0 ? '✓ 一致' : '✗ ' + tblBad + ' 处差异'}（明细 ${detail.length} 聚合 ${agg.length}）`);
    lines.forEach(l => console.log(l));
  }

  // 维表完整性兜底（凌晨 cron 错过时自动补）
  // dim_customer vs wholesale distinct client —— 落后自动调 /derive-dim-customer 补跑
  const wcl = await duck(`SELECT COUNT(DISTINCT client_name) c FROM read_parquet('${S3}/wholesale_detail/**/all.parquet')`);
  const dcl = await pg.query("SELECT COUNT(*)::int c FROM dim_customer WHERE is_active");
  const clientGap = (wcl[0]?.c || 0) - (dcl.rows[0]?.c || 0);
  if (clientGap > 0) {
    console.log(`[dim_customer] ✗ 落后 ${clientGap}（wholesale ${wcl[0].c} vs dim_active ${dcl.rows[0].c}），触发 /derive-dim-customer 补跑`);
    try {
      const dr = await fetch(`${DUCKDB_URL}/derive-dim-customer`, { method: 'POST', headers: { 'x-agent-key': AGENT_API_KEY } });
      const dj = await dr.json();
      console.log(`[dim_customer] 补跑完成: derived ${dj.derived} active ${dj.active}`);
      if ((dj.active || 0) < (wcl[0]?.c || 0)) { bad++; console.log(`  补跑后仍落后 ${wcl[0].c - dj.active}`); }
      else console.log(`  ✓ 已补齐`);
    } catch (e) { bad++; console.log(`  补跑失败: ${e.message}`); }
  } else {
    console.log(`[dim_customer] ✓ 客户数一致（wholesale ${wcl[0]?.c} = dim_active ${dcl.rows[0]?.c}）`);
  }

  // dim_branch 缺漏检查 —— 有销售门店但 dim_branch 没有 = 维表缺（告警，补要 collect-branches）
  const rb = await pg.query(`SELECT COUNT(DISTINCT rds.branch_num)::int c FROM report_daily_sales rds
    LEFT JOIN dim_branch db ON rds.branch_num=db.branch_num AND rds.system_book_code=db.system_book_code
    WHERE rds.biz_date >= date_trunc('day', now() - interval '${DAYS} days') AND db.branch_num IS NULL`);
  if (rb.rows[0]?.c > 0) {
    bad++;
    console.log(`[dim_branch] ✗ ${rb.rows[0].c} 个有销售门店缺 dim_branch（需重跑门店档案采集）`);
  } else {
    console.log(`[dim_branch] ✓ 有销售门店全覆盖`);
  }

  await pg.end();
  console.log(bad === 0 ? '[reconcile] PASS 全部一致' : `[reconcile] FAIL 共 ${bad} 处差异`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('[reconcile] ERR', e.message); process.exit(2); });
