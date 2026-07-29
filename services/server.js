const express = require("express");
const duckdb = require("duckdb");
const AWS = require("aws-sdk");
const { Pool } = require("pg");  // PostgreSQL 连接池

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.DUCKDB_PORT || 9000;

// S3 配置（天翼云 OOS）
const S3_ENDPOINT = process.env.S3_ENDPOINT || "http://xinan-1-internal.zos.ctyun.cn";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "";
const S3_BUCKET = process.env.S3_BUCKET || "lemeng-datasource";

// 智能问数网关鉴权密钥（架构文档 §4.2）：duckdb 服务仅 docker 内网可达，
// AGENT_API_KEY 是其上的防御层——只有持有此 key 的 agent-query 网关能调 /query。
const AGENT_API_KEY = process.env.AGENT_API_KEY || "";
// S3 endpoint 去协议头后的 host（SET s3_endpoint 用），initDuckDB 与每请求连接共用
const S3_ENDPOINT_HOST = S3_ENDPOINT.replace("http://", "").replace("https://", "");

// PostgreSQL 配置（写入汇总结果）
const PG_HOST = process.env.PG_HOST || "postgres";
const PG_PORT = process.env.PG_PORT || 5432;
const PG_DATABASE = process.env.PG_DATABASE || "insforge";
const PG_USER = process.env.PG_USER || "postgres";
const PG_PASSWORD = process.env.PG_PASSWORD || "";

// PostgreSQL 连接池
let pgPool = null;

// DuckDB 连接
let db = null;
let conn = null;

async function initDuckDB() {
  db = new duckdb.Database(":memory:");
  conn = db.connect();

  // 配置 S3（共享连接）
  await configureS3(conn);

  // 初始化 PostgreSQL 连接池
  if (PG_HOST && PG_USER) {
    pgPool = new Pool({
      host: PG_HOST,
      port: PG_PORT,
      database: PG_DATABASE,
      user: PG_USER,
      password: PG_PASSWORD,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    console.log("PostgreSQL pool initialized:", PG_HOST);
  } else {
    console.warn("PostgreSQL not configured, /compute will fail");
  }

  console.log("DuckDB initialized with S3:", S3_ENDPOINT);
}

function runQueryOn(c, sql, timeoutMs = 120000) {
  // 超时保护：duckdb c.all callback 在 S3 慢/挂时可能永不触发，致 Promise 永挂、
  // 连接泄漏（外层 finally close 不执行）。超时强制 close 释放连接 + reject。
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { c.close(); } catch (e) {}
      reject(new Error(`Query timeout ${timeoutMs}ms: ${String(sql).slice(0, 120)}`));
    }, timeoutMs);
    c.all(sql, (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// 共享连接（/transform /merge /compute 用，互不隔离）
function runQuery(sql) {
  return runQueryOn(conn, sql);
}

// 在给定连接上配置 S3（天翼云 OOS）。每请求独立连接不继承全局 SET，必须重配（已实测）。
async function configureS3(c) {
  await runQueryOn(c, "SET s3_endpoint='" + S3_ENDPOINT_HOST + "'");
  await runQueryOn(c, "SET s3_access_key_id='" + S3_ACCESS_KEY + "'");
  await runQueryOn(c, "SET s3_secret_access_key='" + S3_SECRET_KEY + "'");
  await runQueryOn(c, "SET s3_use_ssl=false");
  await runQueryOn(c, "SET s3_region='xinan-1'");
  await runQueryOn(c, "SET http_timeout=30000");  // S3/HTTP 30s 超时，防读慢/挂致连接永挂
}

function escapeSQL(val) {
  if (val == null) return 'NULL';
  // 所有非 NULL 值都用引号包裹（VARCHAR 列）
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function inferType(val) {
  if (typeof val === 'number') return 'DOUBLE';  // 统一用 DOUBLE 避免 BigInt 混用
  if (typeof val === 'boolean') return 'BOOLEAN';
  return 'VARCHAR';
}

function toSQLValue(val, type) {
  if (val == null) return 'NULL';
  if (type === 'DOUBLE') return parseFloat(val) || 0;
  if (type === 'BOOLEAN') return val ? 'true' : 'false';
  return escapeSQL(val);
}

// 健康检查
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "duckdb", s3_endpoint: S3_ENDPOINT });
});

// 查询执行（智能问数网关专用，架构文档 §4.2）
// - AGENT_API_KEY 校验：仅网关可调
// - 每请求独立连接 db.connect()：网关提交的「CREATE TEMP VIEW <权限定义>; <LLM SQL>」
//   中的临时视图随连接天然隔离，跨请求无污染无 race（已实测）
// - 新连接不继承全局 S3 配置，内部重配 configureS3
app.post("/query", async (req, res) => {
  let c = null;
  try {
    const { sql, user_id } = req.body;
    if (!sql) return res.status(400).json({ error: "Missing sql" });

    // AGENT_API_KEY 校验（头 x-agent-key 或 Authorization: Bearer）
    const reqKey = req.headers["x-agent-key"]
      || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!AGENT_API_KEY || reqKey !== AGENT_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("[query] user:", user_id, "sql:", sql.substring(0, 120));

    // 每请求独立连接
    c = db.connect();
    await configureS3(c);
    const result = await runQueryOn(c, sql);

    // DuckDB 的 COUNT/SUM 等聚合可能返回 BigInt，JSON.stringify 默认无法序列化 BigInt
    // 这里统一转成 number（超过 Number.MAX_SAFE_INTEGER 的极少数场景用字符串兜底）
    const safeResult = result.map(row => {
      const safe = {};
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'bigint') {
          safe[k] = v > Number.MAX_SAFE_INTEGER ? v.toString() : Number(v);
        } else {
          safe[k] = v;
        }
      }
      return safe;
    });

    res.json({ success: true, data: safeResult, rowCount: result.length });
  } catch (err) {
    console.error("[query] Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (c) try { c.close(); } catch {}
  }
});

// ===== 通用数据转换端点 =====
app.post("/transform", async (req, res) => {
  const reqKey = req.headers["x-agent-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!AGENT_API_KEY || reqKey !== AGENT_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  const startTime = Date.now();
  let c = null;
  try {
    const { records, config } = req.body;

    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: "Missing or empty records" });
    }
    if (!config || !config.date) {
      return res.status(400).json({ error: "Missing config.date" });
    }

    // 每请求独立连接 + 局部 runQuery 绑定（隔离并发 /transform 的 temp_raw/deduped，仿 /query；新连接需重配 S3）
    c = db.connect();
    await configureS3(c);
    const runQuery = (sql) => runQueryOn(c, sql);

    const {
      date,
      source = 'unknown',
      partition_by = [],
      dedupe_key = [],
      required_fields = [],
      output_format = 'parquet',
      compression = 'zstd',
      base_path = null
    } = config;

    const totalRecords = records.length;
    console.log(`[transform] ${totalRecords} records from ${source} for ${date}`);

    // 所有列用 VARCHAR 避免类型推断问题
    const sampleRow = records[0];
    const schema = Object.keys(sampleRow).map(key => ({ name: key, type: 'VARCHAR' }));

    // 创建临时表（全部 VARCHAR）
    const columnsDef = schema.map(c => `"${c.name}" VARCHAR`).join(', ');
    await runQuery(`CREATE OR REPLACE TEMP TABLE temp_raw (${columnsDef})`);

    // 批量插入
    const batchSize = 1000;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const values = batch.map(row => {
        const cols = schema.map(c => escapeSQL(row[c.name]));
        return '(' + cols.join(', ') + ')';
      }).join(', ');
      await runQuery(`INSERT INTO temp_raw VALUES ${values}`);
    }

    // 数据校验（所有列都是 VARCHAR，只检查 NULL 和空字符串）
    let invalidCount = 0;
    if (required_fields.length > 0) {
      const whereClause = required_fields
        .map(f => `"${f}" IS NULL OR "${f}" = ''`)
        .join(' OR ');
      const result = await runQuery(`SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM temp_raw WHERE ${whereClause}`);
      invalidCount = result[0]?.cnt || 0;
      if (invalidCount > 0) console.warn(`[transform] ${invalidCount} invalid rows`);
    }

    // 去重
    if (dedupe_key.length > 0) {
      const keyCols = dedupe_key.join(', ');
      await runQuery(`
        CREATE OR REPLACE TEMP TABLE deduped AS
        SELECT DISTINCT ON (${keyCols}) *
        FROM temp_raw
        ORDER BY ${keyCols}
      `);
    } else {
      await runQuery("CREATE OR REPLACE TEMP TABLE deduped AS SELECT * FROM temp_raw");
    }

    const dedupedResult = await runQuery("SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM deduped");
    const dedupedCount = dedupedResult[0]?.cnt || totalRecords;
    const duplicatesRemoved = totalRecords - dedupedCount;
    if (duplicatesRemoved > 0) console.log(`[transform] Removed ${duplicatesRemoved} duplicates`);

    // 导出路径
    const basePath = base_path || `${source}/${date}`;
    const exportResults = [];

    // 分片导出
    if (false /* 2026-07-29: 不分片，只写 all.parquet（partition_by 已废弃；all 与分片两份会导致 glob 通配读取翻倍）*/) {
      const partitionValues = await runQuery(
        `SELECT DISTINCT ${partition_by.join(', ')} FROM deduped ORDER BY ${partition_by.join(', ')}`
      );

      for (const pv of partitionValues) {
        const partitionKey = partition_by.map(col => `${col}_${pv[col]}`).join('_');
        const fileName = `${basePath}/${partitionKey}.${output_format}`;
        const s3Path = `s3://${S3_BUCKET}/${fileName}`;
        const whereClause = partition_by.map(col => `${col} = ${pv[col]}`).join(' AND ');

        await runQuery(`
          COPY (SELECT * FROM deduped WHERE ${whereClause})
          TO '${s3Path}' (FORMAT ${output_format.toUpperCase()}, COMPRESSION ${compression.toUpperCase()})
        `);

        const cntResult = await runQuery(`SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM deduped WHERE ${whereClause}`);
        exportResults.push({ file: fileName, partition: pv, records: cntResult[0]?.cnt || 0 });
      }
    }

    // 合并文件
    const allFileName = `${basePath}/all.${output_format}`;
    await runQuery(`
      COPY deduped TO 's3://${S3_BUCKET}/${allFileName}'
      (FORMAT ${output_format.toUpperCase()}, COMPRESSION ${compression.toUpperCase()})
    `);

    // 清理
    await runQuery("DROP TABLE IF EXISTS temp_raw");
    await runQuery("DROP TABLE IF EXISTS deduped");

    const duration = Date.now() - startTime;
    console.log(`[transform] Done: ${exportResults.length + 1} files in ${duration}ms`);

    res.json({
      success: true,
      total_records: totalRecords,
      valid_records: dedupedCount,
      invalid_records: invalidCount,
      duplicates_removed: duplicatesRemoved,
      partition_files: exportResults,
      combined_file: allFileName,
      duration_ms: duration
    });

  } catch (err) {
    console.error("[transform] Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (c) try { c.close(); } catch {}
  }
});

// ===== 增量合并端点（与 /transform 互补）=====
// 用途：增量采集时把新拉取的尾部记录合并进已存在的 all.parquet，按 dedupe_key 去重后写回。
// 与 /transform 的区别：/transform 覆盖写（每小时全量核对用）；/merge 读旧+并新+去重写回（增量续采用）。
// 无已有文件时退化为 /transform 行为（仅写新记录）。
app.post("/merge", async (req, res) => {
  const reqKey = req.headers["x-agent-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!AGENT_API_KEY || reqKey !== AGENT_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  const startTime = Date.now();
  let c = null;
  try {
    const { records, config } = req.body;
    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: "Missing or empty records" });
    }
    if (!config || !config.date) {
      return res.status(400).json({ error: "Missing config.date" });
    }

    // 每请求独立连接 + 局部 runQuery 绑定（隔离并发 /merge 的 temp_raw/old_data/combined/deduped，仿 /query）
    c = db.connect();
    await configureS3(c);
    const runQuery = (sql) => runQueryOn(c, sql);

    const {
      date,
      source = 'unknown',
      partition_by = [],
      dedupe_key = [],
      required_fields = [],
      output_format = 'parquet',
      compression = 'zstd',
      base_path = null
    } = config;

    const totalRecords = records.length;
    console.log(`[merge] ${totalRecords} records from ${source} for ${date}`);

    // 1. 新记录入临时表（全 VARCHAR，与 /transform 一致）
    const newCols = Object.keys(records[0]);
    const columnsDef = newCols.map(c => `"${c}" VARCHAR`).join(', ');
    await runQuery(`CREATE OR REPLACE TEMP TABLE temp_raw (${columnsDef})`);
    const batchSize = 1000;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const values = batch.map(row => {
        const cols = newCols.map(c => escapeSQL(row[c]));
        return '(' + cols.join(', ') + ')';
      }).join(', ');
      await runQuery(`INSERT INTO temp_raw VALUES ${values}`);
    }

    // 2. 校验（同 /transform）
    let invalidCount = 0;
    if (required_fields.length > 0) {
      const whereClause = required_fields.map(f => `"${f}" IS NULL OR "${f}" = ''`).join(' OR ');
      const result = await runQuery(`SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM temp_raw WHERE ${whereClause}`);
      invalidCount = result[0]?.cnt || 0;
      if (invalidCount > 0) console.warn(`[merge] ${invalidCount} invalid rows`);
    }

    // 3. 探测已有 all.parquet（读一行探活，失败即视为首次写入）
    const basePath = base_path || `${source}/${date}`;
    const allFileName = `${basePath}/all.${output_format}`;
    const allS3Path = `s3://${S3_BUCKET}/${allFileName}`;
    let hasExisting = false;
    let existingCols = [];
    try {
      await runQuery(`SELECT * FROM read_parquet('${allS3Path}') LIMIT 1`);
      hasExisting = true;
    } catch (e) {
      console.log(`[merge] no existing parquet at ${allFileName}, writing fresh`);
    }

    // 4. 合并：两侧列取并集，缺失列填 NULL（全 VARCHAR）；保证列名对齐鲁棒
    let combinedCount = totalRecords;
    if (hasExisting) {
      await runQuery(`CREATE OR REPLACE TEMP TABLE old_data AS SELECT * FROM read_parquet('${allS3Path}')`);
      const desc = await runQuery("DESCRIBE old_data");
      existingCols = desc.map(c => c.column_name).filter(Boolean);
      const allCols = Array.from(new Set([...existingCols, ...newCols])).sort();
      const selectList = (avail) => allCols
        .map(c => avail.includes(c) ? `"${c}"` : `CAST(NULL AS VARCHAR) AS "${c}"`)
        .join(', ');
      await runQuery(`CREATE OR REPLACE TEMP TABLE combined AS SELECT ${selectList(existingCols)} FROM old_data UNION ALL SELECT ${selectList(newCols)} FROM temp_raw`);
      const c = await runQuery("SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM combined");
      combinedCount = c[0]?.cnt || totalRecords;
    } else {
      await runQuery("CREATE OR REPLACE TEMP TABLE combined AS SELECT * FROM temp_raw");
    }

    // 5. 去重（DISTINCT ON，重叠页/重复行自动合并）
    if (dedupe_key.length > 0) {
      const keyCols = dedupe_key.join(', ');
      await runQuery(`CREATE OR REPLACE TEMP TABLE deduped AS SELECT DISTINCT ON (${keyCols}) * FROM combined ORDER BY ${keyCols}`);
    } else {
      await runQuery("CREATE OR REPLACE TEMP TABLE deduped AS SELECT * FROM combined");
    }
    const dedupedResult = await runQuery("SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM deduped");
    const dedupedCount = dedupedResult[0]?.cnt || combinedCount;

    // 6. 写回（覆盖 all.parquet + 门店分片，输出与 /transform 一致，消费者无感）
    const exportResults = [];
    if (false /* 2026-07-29: 不分片，只写 all.parquet（partition_by 已废弃；all 与分片两份会导致 glob 通配读取翻倍）*/) {
      const partitionValues = await runQuery(
        `SELECT DISTINCT ${partition_by.join(', ')} FROM deduped ORDER BY ${partition_by.join(', ')}`
      );
      for (const pv of partitionValues) {
        const partitionKey = partition_by.map(col => `${col}_${pv[col]}`).join('_');
        const fileName = `${basePath}/${partitionKey}.${output_format}`;
        const s3Path = `s3://${S3_BUCKET}/${fileName}`;
        const whereClause = partition_by.map(col => `${col} = ${pv[col]}`).join(' AND ');
        await runQuery(`COPY (SELECT * FROM deduped WHERE ${whereClause}) TO '${s3Path}' (FORMAT ${output_format.toUpperCase()}, COMPRESSION ${compression.toUpperCase()})`);
        const cntResult = await runQuery(`SELECT CAST(COUNT(*) AS INTEGER) as cnt FROM deduped WHERE ${whereClause}`);
        exportResults.push({ file: fileName, partition: pv, records: cntResult[0]?.cnt || 0 });
      }
    }
    await runQuery(`COPY deduped TO '${allS3Path}' (FORMAT ${output_format.toUpperCase()}, COMPRESSION ${compression.toUpperCase()})`);

    // 7. 清理
    await runQuery("DROP TABLE IF EXISTS temp_raw");
    await runQuery("DROP TABLE IF EXISTS old_data");
    await runQuery("DROP TABLE IF EXISTS combined");
    await runQuery("DROP TABLE IF EXISTS deduped");

    const duration = Date.now() - startTime;
    console.log(`[merge] Done: combined ${combinedCount} → deduped ${dedupedCount} in ${duration}ms (existing=${hasExisting})`);
    res.json({
      success: true,
      merged: hasExisting,
      new_records: totalRecords,
      combined_records: combinedCount,
      deduped_records: dedupedCount,
      duplicates_removed: combinedCount - dedupedCount,
      invalid_records: invalidCount,
      partition_files: exportResults,
      combined_file: allFileName,
      duration_ms: duration
    });
  } catch (err) {
    console.error("[merge] Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (c) try { c.close(); } catch {}
  }
});

// 兼容旧的 /import 端点（乐檬专用）
app.post("/import", async (req, res) => {
  const { records, date, source } = req.body;

  // 转换为通用格式调用
  req.body = {
    records,
    config: {
      date,
      source: source || 'lemeng',
      partition_by: ['branch_num'],
      dedupe_key: ['order_no', 'order_detail_num'],
      required_fields: ['order_no', 'item_code', 'branch_num']
    }
  };

  // 调用 transform
  return app._router.handle(req, res, () => {});
});

// Schema 信息
app.get("/schema", async (req, res) => {
  try {
    const s3 = new AWS.S3({
      endpoint: S3_ENDPOINT,
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
      s3ForcePathStyle: true,
      region: "xinan-1"
    });

    const list = await s3.listObjectsV2({ Bucket: S3_BUCKET }).promise();
    const files = list.Contents?.filter(f => f.Key.endsWith(".parquet") || f.Key.endsWith(".json"))
      .map(f => ({ key: f.Key, size: f.Size, modified: f.LastModified })) || [];

    res.json({ bucket: S3_BUCKET, files, endpoint: S3_ENDPOINT });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== 计算端点：配置驱动的报表系统 =====
// 架构文档：DuckDB 角色 2 - 计算引擎
// 输入：报表类型 + 日期范围
// 处理：从 report_definitions 读取配置 → 替换 SQL 占位符 → DuckDB 执行 → 写入 PostgreSQL
// 输出：写入 PostgreSQL 汇总表
// 新增报表：只需 INSERT report_definitions，无需修改代码

app.post("/compute", async (req, res) => {
  const reqKey = req.headers["x-agent-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!AGENT_API_KEY || reqKey !== AGENT_API_KEY) return res.status(401).json({ error: "Unauthorized" });
  const startTime = Date.now();
  try {
    const { report_type, date_from, date_to } = req.body;

    if (!report_type || !date_from || !date_to) {
      return res.status(400).json({ error: "Missing report_type, date_from, or date_to" });
    }

    if (!pgPool) {
      return res.status(500).json({ error: "PostgreSQL not configured" });
    }

    console.log(`[compute] ${report_type}: ${date_from} to ${date_to}`);

    // 1. 从数据库读取报表定义
    const defResult = await pgPool.query(
      `SELECT report_type, name, target_table, source_pattern, sql_template,
              field_mapping, date_column, date_format, conflict_keys
       FROM report_definitions
       WHERE report_type = $1 AND enabled = true`,
      [report_type]
    );

    if (defResult.rows.length === 0) {
      return res.status(404).json({ error: `Unknown or disabled report_type: ${report_type}` });
    }

    const config = defResult.rows[0];
    console.log(`[compute] Using config: ${config.name} → ${config.target_table}`);

    // 2. 替换 SQL 模板占位符
    const dateFromCompact = date_from.replace(/-/g, '');
    const dateToCompact = date_to.replace(/-/g, '');

    let sql = config.sql_template;
    sql = sql.replace(/\{\{source_pattern\}\}/g, config.source_pattern);
    sql = sql.replace(/\{\{date_column\}\}/g, config.date_column || 'order_detail_bizday');
    sql = sql.replace(/\{\{date_from\}\}/g, date_from);
    sql = sql.replace(/\{\{date_to\}\}/g, date_to);
    sql = sql.replace(/\{\{date_from_compact\}\}/g, dateFromCompact);
    sql = sql.replace(/\{\{date_to_compact\}\}/g, dateToCompact);

    // 3. 执行 DuckDB 查询
    const rows = await runQuery(sql);
    console.log(`[compute] ${report_type}: ${rows.length} aggregated rows`);

    // 4. 根据字段映射写入 PostgreSQL
    const mapping = config.field_mapping;
    const conflictKeys = config.conflict_keys || [];
    let rowsWritten = 0;

    // DELETE-before-INSERT：先清该日期范围旧数据，避免 sql_template 变更后旧 key 残留
    // dateCol：优先 field_mapping transform 列(daily_* biz_date)；否则 conflict_keys 首列(weekly_trend=week_start)；否则 biz_date
    const dateCol = Object.entries(mapping).find(([_, v]) => v.transform === 'YYYYMMDD_to_YYYY-MM-DD')?.[1]?.pg_column
      || (conflictKeys[0] || 'biz_date');
    await pgPool.query(`DELETE FROM ${config.target_table} WHERE "${dateCol}" BETWEEN $1 AND $2`, [date_from, date_to]);
    console.log(`[compute] ${report_type}: cleared ${dateCol} ${date_from}~${date_to}`);

    for (const row of rows) {
      const pgRow = transformRow(row, mapping);
      await upsertRow(config.target_table, pgRow, conflictKeys);
      rowsWritten++;
    }

    const duration = Date.now() - startTime;
    console.log(`[compute] ${report_type} done: ${rowsWritten} rows in ${duration}ms`);

    res.json({
      success: true,
      report_type,
      report_name: config.name,
      target_table: config.target_table,
      date_from,
      date_to,
      rows_written: rowsWritten,
      duration_ms: duration
    });

  } catch (err) {
    console.error("[compute] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// C3 carry: PG 维表 → S3 parquet（pgPool 读 → DuckDB COPY；不 attach、DuckDB 不连 PG）。
// 维表清单 = 注册表驱动（datasets kind='dim' AND carry_enabled=true），动态、不硬编码。
// 全量读（含敏感列）；列级脱敏在 agent-query view builder per-user 做（can_see_cost），与 retail_detail 一致。
app.post("/carry-dims", async (req, res) => {
  // AGENT_API_KEY 校验（同 /query）
  const reqKey = req.headers["x-agent-key"]
    || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!AGENT_API_KEY || reqKey !== AGENT_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!pgPool) return res.status(500).json({ error: "PostgreSQL not configured" });
  const startedAt = Date.now();
  try {
    // 动态取维表清单（注册表单一事实源；新增维表登记即自动 carry）
    const { rows: dimDs } = await pgPool.query(
      "SELECT name FROM datasets WHERE kind='dim' AND carry_enabled=true ORDER BY name"
    );
    const results = [];
    for (const d of dimDs) {
      const { rows } = await pgPool.query(`SELECT * FROM "${d.name}"`); // 全量，含敏感列
      if (!rows.length) { results.push({ name: d.name, records: 0 }); continue; }
      const schema = Object.keys(rows[0]);
      const colsDef = schema.map(c => `"${c}" VARCHAR`).join(", ");
      await runQuery(`CREATE OR REPLACE TABLE carry_temp (${colsDef})`);
      for (let i = 0; i < rows.length; i += 1000) {
        const batch = rows.slice(i, i + 1000);
        const values = batch.map(r => "(" + schema.map(c => escapeSQL(r[c] == null ? null : String(r[c]))).join(", ") + ")").join(", ");
        await runQuery(`INSERT INTO carry_temp VALUES ${values}`);
      }
      const s3Path = `s3://${S3_BUCKET}/dims/${d.name}.parquet`;
      await runQuery(`COPY carry_temp TO '${s3Path}' (FORMAT PARQUET)`);
      const cnt = await runQuery("SELECT CAST(COUNT(*) AS INTEGER) c FROM carry_temp");
      results.push({ name: d.name, records: cnt[0]?.c || rows.length, path: s3Path });
      console.log(`[carry-dims] ${d.name}: ${cnt[0]?.c || rows.length} rows → ${s3Path}`);
    }
    res.json({ success: true, duration_ms: Date.now() - startedAt, results });
  } catch (err) {
    console.error("[carry-dims] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// A4 derive: wholesale_detail parquet → dim_customer（派生物化）
// DuckDB 读 parquet 全历史 DISTINCT → 软删除(is_active=false) → upsert(标回 true)
// COPY parquet 由 carry-dims 自动（dim_customer 注册 datasets kind=dim carry_enabled）
app.post("/derive-dim-customer", async (req, res) => {
  const reqKey = req.headers["x-agent-key"]
    || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!AGENT_API_KEY || reqKey !== AGENT_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!pgPool) return res.status(500).json({ error: "PostgreSQL not configured" });
  const startedAt = Date.now();
  try {
    // 1. DuckDB 派生（共享 conn；批发只 3120，parquet 无 system_book_code 列→硬编码）
    const deriveSql = `
      SELECT '3120' AS system_book_code, client_code,
             arg_max(client_name, audit_time) AS client_name,
             MIN(CAST(audit_time AS DATE)) AS first_order_date,
             MAX(CAST(audit_time AS DATE)) AS last_order_date,
             COUNT(DISTINCT CAST(audit_time AS DATE)) AS active_days
      FROM read_parquet('s3://${S3_BUCKET}/lemeng/wholesale_detail/*/*/all.parquet')
      WHERE client_code IS NOT NULL AND client_code <> ''
      GROUP BY client_code`;
    const rows = await runQuery(deriveSql);
    console.log(`[derive-dim-customer] derived ${rows.length} customers`);

    // 2-3. 事务：软删除 + upsert（失败 ROLLBACK，避免 is_active 全 false 残留）
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE dim_customer SET is_active = false, updated_at = NOW()");
      for (const r of rows) {
        await client.query(
          `INSERT INTO dim_customer (system_book_code, client_code, client_name, first_order_date, last_order_date, active_days, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           ON CONFLICT (system_book_code, client_code) DO UPDATE SET
             client_name=EXCLUDED.client_name, first_order_date=EXCLUDED.first_order_date,
             last_order_date=EXCLUDED.last_order_date, active_days=EXCLUDED.active_days,
             is_active=true, updated_at=NOW()`,
          [r.system_book_code, r.client_code, r.client_name, r.first_order_date, r.last_order_date, r.active_days]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // 4. 统计
    const cnt = await pgPool.query("SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE is_active)::int AS a FROM dim_customer");
    res.json({
      success: true,
      derived: rows.length,
      total: cnt.rows[0].n,
      active: cnt.rows[0].a,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("[derive-dim-customer] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 字段转换函数
function transformRow(row, mapping) {
  const result = {};
  for (const [sourceCol, config] of Object.entries(mapping)) {
    let value = row[sourceCol];

    // 应用转换
    if (config.transform === 'YYYYMMDD_to_YYYY-MM-DD' && value) {
      value = value.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    }

    result[config.pg_column] = value;
  }
  return result;
}

// UPSERT 函数（动态生成）
async function upsertRow(tableName, row, conflictKeys) {
  const columns = Object.keys(row);
  const values = Object.values(row);
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

  // 构建 UPDATE 部分（排除冲突键）
  const updateCols = columns.filter(c => !conflictKeys.includes(c));
  const updateClause = updateCols.length > 0
    ? updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ') + ', updated_at = NOW()'
    : 'updated_at = NOW()';

  const sql = `
    INSERT INTO ${tableName} (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (${conflictKeys.join(', ')}) DO UPDATE SET ${updateClause}
  `;

  await pgPool.query(sql, values);
}

// 查询报表定义列表
app.get("/reports", async (req, res) => {
  try {
    if (!pgPool) {
      return res.status(500).json({ error: "PostgreSQL not configured" });
    }

    const result = await pgPool.query(
      `SELECT report_type, name, target_table, enabled, created_at
       FROM report_definitions
       ORDER BY id`
    );

    res.json({ reports: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 启动
initDuckDB().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("DuckDB service running on port", PORT);
  });
}).catch(err => {
  console.error("Failed to init:", err);
  process.exit(1);
});