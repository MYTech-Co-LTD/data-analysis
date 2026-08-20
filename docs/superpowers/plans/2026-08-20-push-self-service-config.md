# 推送自助配置平台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 业务人员（push:configure 持有者）在 web 管理端自助配置推送：模板库（企微 news_notice 卡片表单+预览+测试发自己）+ 推送任务（收件人/定时/目标跟随或固定），目标结束自动停推并提醒。

**Architecture:** 两张表（`push_message_presets` 演进为模板库 + 新表 `push_configs` 任务）→ admin API CRUD（复用 /api/push 的 checkPushPerm 权限闸）→ 既有 scheduler job（`__scheduled_reports` 每小时扫）读 push_configs 触发 → 既有 runPush 引擎（resolveNumericValue 加 follow/fixed 查询参数）→ Novu（零改动）→ bridge → 企微。

**Tech Stack:** Next.js 15 route handlers / React client 组件（现有 admin 页 tailwind 模式）/ PostgreSQL 迁移（幂等）/ vitest。

**Spec:** `docs/superpowers/specs/2026-08-20-push-self-service-config-design.md`

## Global Constraints

- Novu 侧零改动（§7.4 边界：workflow 保持单 step 单变量 `{{{message_content}}}` 透传）
- 消息类型统一 `template_card news_notice`（2026-08-20 裁定）；text/markdown 仅兼容保留
- 变量 UI 只显示通俗中文名（name）+ 口径说明（description），`var_code` 不出现在任何界面
- 迁移幂等：`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `ON CONFLICT DO UPDATE`
- 权限：所有写操作过 `push:configure`（全员 selector 另需 `push:broadcast`）
- UI 遵循 DESIGN.md（DM Sans / tabular-nums / 主色深蓝 #1E40AF / slate 中性）
- PostgREST 直连模式：`process.env.POSTGREST_URL` + `INSFORGE_API_KEY`（照 `web/app/api/admin/targets/route.ts`）
- 测试：vitest（`cd web && npx vitest run lib/push lib/jobs --reporter=default`）；现有 75+ 测试不回归
- 企微卡片字段限制（校验用，来自 `docs/ops/wecom-message-capabilities.md`）：main_title.title≤128B / main_title.desc≤512B / description≤512B / card_action.url≤1024B / vertical_content_list≤4 行 / horizontal_content_list≤6 行 / card_image.aspect_ratio 1.3~2.25
- commit 走 pre-commit hooks（lint-staged + edge functions 检查），消息格式照仓库惯例

## File Structure（全景）

```
database/migrations/204_push_self_service.sql          # T1 表/列/变量数据
web/lib/push/index.ts                                  # T2 引擎（resolveNumericValue/loadPreset/opts）
web/lib/push/__tests__/run-push.test.ts                # T2 追加测试
web/lib/jobs/scheduled-reports/cron-match.ts           # T3 新建（纯函数）
web/lib/jobs/scheduled-reports/__tests__/cron-match.test.ts  # T3
web/lib/push/target-guard.ts                           # T4 新建（结束守卫）
web/lib/push/__tests__/target-guard.test.ts            # T4
web/app/api/push/route.ts                              # T5 presetId/selfTest
web/lib/push/__tests__/push-api.test.ts                # T5 追加
web/lib/jobs/scheduled-reports/manifest.ts             # T6 调度改造
web/lib/push/preset-validate.ts                        # T7 新建（card_json 校验）
web/lib/push/__tests__/preset-validate.test.ts         # T7
web/app/api/admin/push-presets/route.ts                # T7
web/app/api/admin/push-configs/route.ts                # T9
web/components/admin/push/CardPreview.tsx              # T8 新建（卡片预览）
web/app/admin/push/presets/page.tsx                    # T8 模板管理页
web/app/admin/push/configs/page.tsx                    # T10 任务管理页
```

---

### Task 1: 迁移 204——表结构与变量数据

**Files:**
- Create: `database/migrations/204_push_self_service.sql`

**Interfaces:**
- Produces: 表 `push_configs`（列见 SQL）；`push_message_presets` 增 `name TEXT` / `updated_by TEXT`；`push_variables` 增 `description TEXT` + 7 行定稿数据（后续任务全部依赖）

- [ ] **Step 1: 写迁移文件**

```sql
-- 204_push_self_service.sql
-- 推送自助配置（spec 2026-08-20-push-self-service-config）：
--   1) push_message_presets 演进为模板库（加 name/updated_by，workflow_id 退役为可选关联）
--   2) push_variables 加 description（通俗口径说明）+ 7 变量定稿（UI 只显 name+description）
--   3) push_configs 推送任务表（替代旧 scheduled_reports 角色，旧表退役不迁移）
-- 幂等：IF NOT EXISTS / ON CONFLICT DO UPDATE。
BEGIN;

-- 1) 模板库演进
ALTER TABLE push_message_presets ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE push_message_presets ADD COLUMN IF NOT EXISTS updated_by TEXT;
COMMENT ON COLUMN push_message_presets.name IS '模板名（管理页显示；为空时回退 preset_id）';

-- 2) 变量通俗化 + 补齐
ALTER TABLE push_variables ADD COLUMN IF NOT EXISTS description TEXT;

INSERT INTO push_variables (var_code, name, description, metric_code, scope_dim, unit, enabled) VALUES
  ('sale_amount',     '销售额',     '当前进行中目标的销售实际值，按收件人权限范围统计', 'sale_amount',     'total', '元', true),
  ('achievement_rate','销售达成率', '销售实际÷目标（当前进行中目标），按收件人权限范围',  'sale_rate',       'total', '%',  true),
  ('delivery_amount', '配送额',     '当前进行中目标的配送实际值',                        'delivery_amount', 'total', '元', true),
  ('delivery_rate',   '配送达成率', '配送实际÷目标（当前进行中目标）',                    'delivery_amount', 'total', '%',  true),
  ('outbound_amt',    '出库金额',   '配送+批发出库合计金额',                              'outbound_amt',    'total', '元', true),
  ('outbound_profit', '出库毛利',   '配送+批发出库合计毛利',                              'outbound_profit', 'total', '元', true),
  ('detail_url',      '门店明细入口','点开直达收件人有权限的门店明细报表',                 NULL,              'total', NULL, true)
ON CONFLICT (var_code) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description,
  metric_code = EXCLUDED.metric_code, unit = EXCLUDED.unit, enabled = EXCLUDED.enabled;

-- ⚠️ delivery_rate 的 metric_code 用 delivery_amount 查视图 delivery 行的 achievement_rate（rate 类按视图列取，见 T2）
```

注意上表 `delivery_rate` 的 metric_code 与 `delivery_amount` 相同（引擎 METRIC_TO_VIEW 把两者都映到视图 `delivery` 行，rate 类按 `achievement_rate` 列取——见 Task 2 实现，var_code 以 `*_rate`/`achievement_rate` 结尾判定 rate 形态）。

继续写 3)：

```sql
-- 3) 推送任务表
CREATE TABLE IF NOT EXISTS push_configs (
  config_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  cron_spec            JSONB NOT NULL,        -- {kind: daily|weekly|monthly, time: "HH:mm", weekday?: 1-7(周一=1), day?: 1-31}
  enabled              BOOLEAN NOT NULL DEFAULT true,
  selector_json        JSONB NOT NULL,        -- {kind: dept|person, ids: [...]}
  target_mode          TEXT NOT NULL DEFAULT 'follow' CHECK (target_mode IN ('follow','fixed')),
  target_id            BIGINT,                -- fixed 模式必填 → targets.id
  preset_id            TEXT NOT NULL,
  owner_wecom_id       TEXT NOT NULL,
  last_run_date        DATE,
  last_run_txn_id      TEXT,
  last_guard_notice_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_configs_enabled ON push_configs(enabled) WHERE enabled;
GRANT SELECT, INSERT, UPDATE ON push_configs TO anon, authenticated;

-- 旧 scheduled_reports 退役标记（生产 0 行，保留表不迁移）
COMMENT ON TABLE scheduled_reports IS 'DEPRECATED 2026-08-20：推送任务改 push_configs（spec 2026-08-20-push-self-service-config）';

COMMIT;
```

- [ ] **Step 2: 本地语法校验**

Run: `cd database && psql -h localhost -p 5433 -U postgres -d insforge -f migrations/204_push_self_service.sql`（无本地库则跳过，Step 4 生产验证）
Expected: 全部 `ALTER TABLE` / `CREATE TABLE` 成功，重复执行第二遍也成功（幂等）

- [ ] **Step 3: Commit**

```bash
git add database/migrations/204_push_self_service.sql
git commit -m "feat(push): 迁移 204——push_configs 任务表 + 模板库/变量通俗化（spec 2026-08-20）"
```

---

### Task 2: 引擎——取值 follow/fixed + presetId 直取

**Files:**
- Modify: `web/lib/push/index.ts`（RunPushOpts / resolveNumericValue / loadWorkflowPreset）
- Test: `web/lib/push/__tests__/run-push.test.ts`（追加）

**Interfaces:**
- Produces: `RunPushOpts` 增 `presetId?: string; targetMode?: 'follow'|'fixed'; targetId?: number; variables?: Record<string,string>`；`resolveNumericValue(metricCode, jwt, target?)` 三参形态；`loadPreset(presetId)` 按 presetId 直取
- Consumes: T1 的表结构（无代码依赖）

- [ ] **Step 1: 追加失败测试**

在 `web/lib/push/__tests__/run-push.test.ts` 末尾（`describe('runPush')` 内）追加：

```typescript
  it('follow 模式取值 URL 带「今天落区间」过滤 + tie-break（回归：最新≠进行中）', async () => {
    vi.stubEnv('PUSH_VARIABLES_JSON', JSON.stringify([
      { var_code: 'sale_amount', name: '销售额', metric_code: 'sale_amount', scope_dim: 'total', unit: '元', enabled: true },
    ]));
    const { resetCache } = await import('../push-variables');
    resetCache();

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ paused: false }]) });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'u1', wecom_id: 'wx1', is_active: true }]) });
      }
      if (url.includes('get_user_perms_strict')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ brands: ['*'], branch_nums: ['*'], categories: [], can_see_cost: true }) });
      }
      if (url.includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([
          { actual_value: 4200000, achievement_rate: 0.61 },
        ]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const { runPush } = await import('../index');
    await runPush({
      workflowId: 'scheduled-report',
      selector: { kind: 'person', ids: ['wx1'] },
      operatorId: 'admin',
      broadcastPerm: false,
      targetMode: 'follow',
    });

    const genCalls = mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('report_achievement_gen'));
    expect(genCalls.length).toBeGreaterThan(0);
    for (const url of genCalls) {
      expect(url).toContain('status=eq.active');
      expect(url).toMatch(/start_date=lte\.\d{4}-\d{2}-\d{2}/);
      expect(url).toMatch(/end_date=gte\.\d{4}-\d{2}-\d{2}/);
      expect(url).toContain('order=start_date.desc,end_date.asc');
      expect(url).toContain('limit=1');
    }
  });

  it('fixed 模式取值 URL 带 target_id 过滤', async () => {
    vi.stubEnv('PUSH_VARIABLES_JSON', JSON.stringify([
      { var_code: 'sale_amount', name: '销售额', metric_code: 'sale_amount', scope_dim: 'total', unit: '元', enabled: true },
    ]));
    const { resetCache } = await import('../push-variables');
    resetCache();

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ paused: false }]) });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'u1', wecom_id: 'wx1', is_active: true }]) });
      }
      if (url.includes('get_user_perms_strict')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ brands: ['*'], branch_nums: ['*'], categories: [], can_see_cost: true }) });
      }
      if (url.includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ actual_value: 100, achievement_rate: 0.5 }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const { runPush } = await import('../index');
    await runPush({
      workflowId: 'scheduled-report',
      selector: { kind: 'person', ids: ['wx1'] },
      operatorId: 'admin',
      broadcastPerm: false,
      targetMode: 'fixed',
      targetId: 823,
    });

    const genCalls = mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('report_achievement_gen'));
    for (const url of genCalls) {
      expect(url).toContain('target_id=eq.823');
      expect(url).not.toContain('start_date=lte');
    }
  });

  it('presetId 直取：preset 查询按 preset_id 而非 workflow_id', async () => {
    vi.stubEnv('PUSH_VARIABLES_JSON', JSON.stringify([
      { var_code: 'sale_amount', name: '销售额', metric_code: 'sale_amount', scope_dim: 'total', unit: '元', enabled: true },
    ]));
    const { resetCache } = await import('../push-variables');
    resetCache();

    mockFetch.mockImplementation((url: string) => {
      if (url.includes('require_push_owner')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ paused: false }]) });
      }
      if (url.includes('org_users')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'u1', wecom_id: 'wx1', is_active: true }]) });
      }
      if (url.includes('get_user_perms_strict')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ brands: ['*'], branch_nums: ['*'], categories: [], can_see_cost: true }) });
      }
      if (url.includes('push_message_presets')) {
        if (url.includes('preset_id=eq.preset-xyz')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([
            { preset_id: 'preset-xyz', workflow_id: 'w', msgtype: 'template_card', card_json: { card_type: 'news_notice', main_title: { title: 'X {{sale_amount}}' } }, enabled: true },
          ]) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ actual_value: 42, achievement_rate: 0.5 }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const { runPush } = await import('../index');
    const result = await runPush({
      workflowId: 'scheduled-report',
      presetId: 'preset-xyz',
      selector: { kind: 'person', ids: ['wx1'] },
      operatorId: 'admin',
      broadcastPerm: false,
    });

    expect(result.renderedGroups?.[0]?.rendered.message_content).toContain('X ¥42');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/push/__tests__/run-push.test.ts`
Expected: FAIL（URL 断言不过——现有实现无 start_date=lte / target_id / preset_id=eq 查询）

- [ ] **Step 3: 改实现（web/lib/push/index.ts）**

3a. `RunPushOpts` 扩展（L39-45 替换为）：

```typescript
export interface RunPushOpts {
  workflowId: string;
  /** 按模板库直取 preset（优先于按 workflowId 查找） */
  presetId?: string;
  selector: Selector;
  operatorId: string;
  broadcastPerm: boolean;
  deliver?: boolean; // false = shadow (默认)
  /** 数值取值目标：follow=今天落区间（默认，向后兼容）；fixed=锁定 target_id */
  targetMode?: 'follow' | 'fixed';
  targetId?: number;
  /** route 兼容字段（/api/push 透传，暂无消费方） */
  variables?: Record<string, string>;
}
```

3b. `resolveNumericValue` 改签名与查询（L126-151 整体替换）：

```typescript
/** rate 类变量判定：var_code 以 _rate 结尾或为 achievement_rate（rate 按视图 achievement_rate 列取） */
const isRateVar = (code: string) => /_rate$/.test(code) || code === 'achievement_rate';

async function resolveNumericValue(
  metricCode: string | undefined,
  jwt: string,
  target: { mode: 'follow' | 'fixed'; id?: number } = { mode: 'follow' },
  varCode?: string,
): Promise<string | null> {
  if (!metricCode) return null;
  const viewMetric = METRIC_TO_VIEW[metricCode];
  if (!viewMetric) return null;
  const { postgrestUrl } = getConfig();
  if (!postgrestUrl) return null;
  try {
    // follow：今天落区间（周期结束自动取不到→变量跳过；提前建下月不误取）
    //   tie-break：start_date.desc, end_date.asc = 取开始最晚结束最早的周期（粒度最细，8月优先于Q3）
    // fixed：锁定 target_id（视图外层已输出 target_id 列，见 report_achievement_gen.sql）
    const today = new Date().toISOString().slice(0, 10);
    const targetFilter = target.mode === 'fixed' && target.id
      ? `&target_id=eq.${target.id}`
      : `&start_date=lte.${today}&end_date=gte.${today}`;
    const resp = await fetch(
      `${postgrestUrl}/report_achievement_gen?select=metric_code,actual_value,target_value,achievement_rate`
      + `&metric_code=eq.${viewMetric}&status=eq.active${targetFilter}`
      + `&order=start_date.desc,end_date.asc&limit=1`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    if (!resp.ok) return null;
    const rows = await resp.json() as Array<{ actual_value: number | null; achievement_rate: number | null }>;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const row = rows[0];
    if (isRateVar(varCode ?? '')) {
      const rate = Number(row.achievement_rate);
      return rate > 0 ? `${(rate * 100).toFixed(1)}%` : null;
    }
    if (row.actual_value === null || row.actual_value === undefined) return null;
    return `¥${fmtCN(Number(row.actual_value))}`;
  } catch {
    return null;
  }
}
```

3c. `loadWorkflowPreset` 加 presetId 分支（L157-171 的函数改为，函数名保留避免大改调用点）：

```typescript
async function loadWorkflowPreset(workflowId: string, presetId?: string): Promise<MessagePreset | null> {
  const { postgrestUrl, postgrestKey } = getConfig();
  if (!postgrestUrl || !postgrestKey) return null;
  try {
    const where = presetId
      ? `preset_id=eq.${encodeURIComponent(presetId)}`
      : `workflow_id=eq.${encodeURIComponent(workflowId)}&enabled=eq.true`;
    const resp = await fetch(`${postgrestUrl}/push_message_presets?${where}`, {
      headers: { Authorization: `Bearer ${postgrestKey}` },
    });
    if (!resp.ok) return null;
    const rows = await resp.json() as MessagePreset[];
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}
```

3d. runPush 内两处接线：
- preset 加载行（原 `const preset = await loadWorkflowPreset(opts.workflowId);`）改：
  `const preset = await loadWorkflowPreset(opts.workflowId, opts.presetId);`
- 取值回调（renderVariables 内 `return await resolveNumericValue(v?.metric_code, jwt);`）改：
  `return await resolveNumericValue(v?.metric_code, jwt, { mode: opts.targetMode ?? 'follow', id: opts.targetId }, code);`

- [ ] **Step 4: 跑测试确认通过（含既有测试不回归）**

Run: `cd web && npx vitest run lib/push --reporter=default`
Expected: 全部 PASS（含既有 §12.1 回归测试——注意它断言 `order=start_date.desc`，新实现 `order=start_date.desc,end_date.asc` 仍含该子串，通过）

- [ ] **Step 5: typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: 0 错误（route.ts 的 variables 传参自此对齐）

- [ ] **Step 6: Commit**

```bash
git add web/lib/push/index.ts web/lib/push/__tests__/run-push.test.ts
git commit -m "feat(push): 取值 follow/fixed 查询参数化（今天落区间+tie-break/target_id）+ presetId 直取"
```

---

### Task 3: cron 匹配纯函数

**Files:**
- Create: `web/lib/jobs/scheduled-reports/cron-match.ts`
- Create: `web/lib/jobs/scheduled-reports/__tests__/cron-match.test.ts`

**Interfaces:**
- Produces:
  - `interface CronSpec { kind: 'daily' | 'weekly' | 'monthly'; time: string; weekday?: number; day?: number }`
  - `matchesDate(spec: CronSpec, d: Date): boolean` — 该日期是否为 due 日（time 字段不参与：job 每小时扫，当日 due 且未跑即补，见 T6）
  - `nextRunLabel(spec: CronSpec, from: Date): string` — 管理页「下次触发」显示（如「每天 08:30」「每周五 17:00」「每月 1 日 09:00」）

- [ ] **Step 1: 写失败测试**

```typescript
// web/lib/jobs/scheduled-reports/__tests__/cron-match.test.ts
import { describe, it, expect } from 'vitest';
import { matchesDate, nextRunLabel } from '../cron-match';

describe('matchesDate', () => {
  it('daily：每天 due', () => {
    expect(matchesDate({ kind: 'daily', time: '08:30' }, new Date('2026-08-20'))).toBe(true);
    expect(matchesDate({ kind: 'daily', time: '08:30' }, new Date('2026-08-21'))).toBe(true);
  });
  it('weekly：仅指定周几 due（周一=1）', () => {
    // 2026-08-21 是周五（weekday=5）
    expect(matchesDate({ kind: 'weekly', time: '17:00', weekday: 5 }, new Date('2026-08-21'))).toBe(true);
    expect(matchesDate({ kind: 'weekly', time: '17:00', weekday: 5 }, new Date('2026-08-20'))).toBe(false);
  });
  it('monthly：仅指定日 due；当月无该日则全月不 due（2月无31）', () => {
    expect(matchesDate({ kind: 'monthly', time: '09:00', day: 1 }, new Date('2026-08-01'))).toBe(true);
    expect(matchesDate({ kind: 'monthly', time: '09:00', day: 1 }, new Date('2026-08-15'))).toBe(false);
    // 2026-02 无 31 日
    expect(matchesDate({ kind: 'monthly', time: '09:00', day: 31 }, new Date('2026-02-10'))).toBe(false);
    expect(matchesDate({ kind: 'monthly', time: '09:00', day: 31 }, new Date('2026-01-31'))).toBe(true);
  });
});

describe('nextRunLabel', () => {
  it('各 kind 输出通俗中文', () => {
    expect(nextRunLabel({ kind: 'daily', time: '08:30' }, new Date('2026-08-20'))).toBe('每天 08:30');
    expect(nextRunLabel({ kind: 'weekly', time: '17:00', weekday: 5 }, new Date('2026-08-20'))).toBe('每周五 17:00');
    expect(nextRunLabel({ kind: 'monthly', time: '09:00', day: 1 }, new Date('2026-08-20'))).toBe('每月1日 09:00');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/jobs/scheduled-reports/__tests__/cron-match.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// web/lib/jobs/scheduled-reports/cron-match.ts
// cron_spec 匹配（spec §5）：结构化频率，业务人员不见 cron 表达式。
// 当日补发语义由 job 侧实现（matchesDate 只判「该日是否 due」，time 不参与——
//   job 每小时扫，「今日 due 且 last_run_date < 今天」即触发，跨日不补）。

export interface CronSpec {
  kind: 'daily' | 'weekly' | 'monthly';
  time: string;        // "HH:mm"
  weekday?: number;    // weekly：1-7（周一=1）
  day?: number;        // monthly：1-31
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 该日期是否 due（本地时区语义：用 getDay/getDate，服务器 TZ=Asia/Shanghai 部署） */
export function matchesDate(spec: CronSpec, d: Date): boolean {
  switch (spec.kind) {
    case 'daily':
      return true;
    case 'weekly': {
      // JS getDay(): 周日=0..周六=6 → 周一=1 起的 weekday
      const jsDay = d.getDay() === 0 ? 7 : d.getDay();
      return jsDay === spec.weekday;
    }
    case 'monthly': {
      const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (spec.day! > daysInMonth) return false; // 当月无该日（2月无31）→ 当月跳过
      return d.getDate() === spec.day;
    }
    default:
      return false;
  }
}

/** 管理页「下次触发」显示 */
export function nextRunLabel(spec: CronSpec, _from: Date): string {
  switch (spec.kind) {
    case 'daily': return `每天 ${spec.time}`;
    case 'weekly': return `每${WEEKDAYS[(spec.weekday ?? 1) - 1]} ${spec.time}`;
    case 'monthly': return `每月${spec.day}日 ${spec.time}`;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/jobs/scheduled-reports/__tests__/cron-match.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/lib/jobs/scheduled-reports/cron-match.ts web/lib/jobs/scheduled-reports/__tests__/cron-match.test.ts
git commit -m "feat(push): cron_spec 匹配纯函数（daily/weekly/monthly+当月无效日跳过）"
```

---

### Task 4: 目标结束守卫

**Files:**
- Create: `web/lib/push/target-guard.ts`
- Create: `web/lib/push/__tests__/target-guard.test.ts`

**Interfaces:**
- Produces:
  - `checkTargetActive(mode: 'follow'|'fixed', targetId: number|undefined): Promise<{ active: boolean; reason: string }>` — follow 试查视图「今天落区间」有行；fixed 查 targets.status=active
  - `notifyOwnerOnce(config: { configId: string; ownerWecomId: string; name: string }): Promise<void>` — 一次性企微提醒（DB 防重 24h，`last_guard_notice_at`）+ wecom markdown 发送

- [ ] **Step 1: 写失败测试**

```typescript
// web/lib/push/__tests__/target-guard.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../wecom-send', () => ({
  sendWecomMarkdown: vi.fn().mockResolvedValue({ ok: true, errcode: 0, errmsg: '', sent_to: 'x', msgtype: 'markdown' }),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('target-guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('POSTGREST_URL', 'http://localhost:3000');
    vi.stubEnv('POSTGREST_ANON_KEY', 'test-key');
    vi.stubEnv('WECOM_CORP_ID', 'c');
    vi.stubEnv('WECOM_OPS_SECRET', 's');
    vi.stubEnv('WECOM_OPS_AGENT_ID', '1');
  });

  it('follow：今天落区间有行 → active', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ metric_code: 'sale' }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { checkTargetActive } = await import('../target-guard');
    expect(await checkTargetActive('follow', undefined)).toEqual({ active: true, reason: '' });
  });

  it('follow：无进行中行 → inactive（查询带区间过滤断言）', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('report_achievement_gen')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { checkTargetActive } = await import('../target-guard');
    const r = await checkTargetActive('follow', undefined);
    expect(r.active).toBe(false);
    expect(r.reason).toContain('无进行中目标');
    const call = String(mockFetch.mock.calls.find((c) => String(c[0]).includes('report_achievement_gen'))?.[0]);
    expect(call).toMatch(/start_date=lte\.\d{4}-\d{2}-\d{2}/);
    expect(call).toMatch(/end_date=gte\.\d{4}-\d{2}-\d{2}/);
  });

  it('fixed：目标 status=active → active；closed → inactive', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('targets?id=eq.823')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 823, status: 'closed' }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { checkTargetActive } = await import('../target-guard');
    const r = await checkTargetActive('fixed', 823);
    expect(r.active).toBe(false);
    expect(r.reason).toContain('已结束');
  });

  it('notifyOwnerOnce：24h 内已提醒过 → 不重发', async () => {
    mockFetch.mockImplementation((url: string) => {
      // 防重读取：返回 1 小时前提醒过
      if (String(url).includes('push_configs?config_id=eq')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ last_guard_notice_at: new Date(Date.now() - 3600_000).toISOString() }]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    const { notifyOwnerOnce } = await import('../target-guard');
    const { sendWecomMarkdown } = await import('../../wecom-send');
    await notifyOwnerOnce({ configId: 'c1', ownerWecomId: 'ZhangDuo', name: '每日销售日报' });
    expect(sendWecomMarkdown).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/push/__tests__/target-guard.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// web/lib/push/target-guard.ts
// 目标结束守卫（spec §3.4）：触发前检查数据源目标——
//   follow：视图「今天落区间」是否有行；fixed：targets.status 是否 active。
//   不 active → 跳过本次 + owner 一次性企微提醒（last_guard_notice_at 24h 防重）。

import { sendWecomMarkdown } from '../wecom-send';

function pg() {
  const url = process.env.POSTGREST_URL || '';
  const key = process.env.POSTGREST_ANON_KEY || process.env.INSFORGE_API_KEY || '';
  return { url, headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' } };
}

export async function checkTargetActive(
  mode: 'follow' | 'fixed',
  targetId: number | undefined,
): Promise<{ active: boolean; reason: string }> {
  const { url, headers } = pg();
  if (!url) return { active: false, reason: 'POSTGREST_URL 未配置' };
  try {
    if (mode === 'fixed') {
      if (!targetId) return { active: false, reason: 'fixed 模式缺 target_id' };
      const resp = await fetch(`${url}/targets?id=eq.${targetId}&select=id,status`, { headers });
      const rows = await resp.json().catch(() => []);
      const status = Array.isArray(rows) && rows[0]?.status;
      return status === 'active'
        ? { active: true, reason: '' }
        : { active: false, reason: `目标 ${targetId} 已结束或不存在（status=${status ?? '无'}）` };
    }
    // follow：与引擎取值同口径（今天落区间），service 侧探测（不涉敏感数据，有行即可）
    const today = new Date().toISOString().slice(0, 10);
    const resp = await fetch(
      `${url}/report_achievement_gen?select=metric_code&status=eq.active`
      + `&start_date=lte.${today}&end_date=gte.${today}&limit=1`,
      { headers },
    );
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0
      ? { active: true, reason: '' }
      : { active: false, reason: '无进行中目标（今天不在任何 active 目标周期内）' };
  } catch (e) {
    return { active: false, reason: `守卫查询失败：${String(e)}` };
  }
}

/** 一次性 owner 提醒（24h 防重，DB last_guard_notice_at） */
export async function notifyOwnerOnce(config: { configId: string; ownerWecomId: string; name: string }): Promise<void> {
  const { url, headers } = pg();
  if (!url) return;
  try {
    const read = await fetch(`${url}/push_configs?config_id=eq.${config.configId}&select=last_guard_notice_at`, { headers });
    const rows = await read.json().catch(() => []);
    const last = Array.isArray(rows) && rows[0]?.last_guard_notice_at ? new Date(rows[0].last_guard_notice_at).getTime() : 0;
    if (Date.now() - last < 24 * 3600_000) return; // 24h 内已提醒

    await fetch(`${url}/push_configs?config_id=eq.${config.configId}`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ last_guard_notice_at: new Date().toISOString() }),
    });

    await sendWecomMarkdown(
      config.ownerWecomId,
      `⏸️ 推送任务「${config.name}」已暂停：数据源目标已结束（无进行中目标）。请在推送任务管理页更换目标或等待新目标建立。`,
    );
  } catch (e) {
    console.error('[target-guard] owner 提醒失败', e);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run lib/push/__tests__/target-guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/lib/push/target-guard.ts web/lib/push/__tests__/target-guard.test.ts
git commit -m "feat(push): 目标结束守卫——follow 试查/fixed 查状态 + owner 一次性提醒 24h 防重"
```

---

### Task 5: /api/push 扩展——presetId / selfTest

**Files:**
- Modify: `web/app/api/push/route.ts`（trigger 段，约 L387-470）
- Test: `web/lib/push/__tests__/push-api.test.ts`（追加）

**Interfaces:**
- Consumes: T2 的 `RunPushOpts.presetId/targetMode/targetId/variables`
- Produces: trigger body 新增可选字段 `presetId: string`、`selfTest: boolean`、`targetMode/targetId`（selfTest=true 时服务端强制 selector=操作者本人，忽略 body.selector）

- [ ] **Step 1: 追加失败测试**

在 `push-api.test.ts` 中（照该文件现有 mock 模式，确保已有 `runPush` mock 与权限 mock 的基础设施；若无则按 run-push.test.ts 的 mockFetch 模式补）追加：

```typescript
  it('selfTest=true：强制 selector=操作者本人（伪造的 body.selector 被覆盖）', async () => {
    // 权限与守卫 mock（照现有测试）…
    const body = {
      workflowId: 'scheduled-report',
      selector: { kind: 'person', ids: ['SomeoneElse'] }, // 伪造他人
      userId: 'ZhangDuo',
      selfTest: true,
    };
    const r = await fetch('/api/push', { /* 照现有测试的请求封装 */ method: 'POST', body: JSON.stringify(body) });
    const j = await r.json();
    // runPush 收到的 selector 必须是 person:[ZhangDuo]
    expect(runPushMock).toHaveBeenCalledWith(expect.objectContaining({
      selector: { kind: 'person', ids: ['ZhangDuo'] },
    }));
  });

  it('presetId 透传到 runPush', async () => {
    const body = {
      workflowId: 'scheduled-report',
      presetId: 'preset-xyz',
      selector: { kind: 'person', ids: ['ZhangDuo'] },
      userId: 'ZhangDuo',
    };
    await fetch('/api/push', { method: 'POST', body: JSON.stringify(body) });
    expect(runPushMock).toHaveBeenCalledWith(expect.objectContaining({ presetId: 'preset-xyz' }));
  });
```

（实现者注：以该文件**现有的** mock/runPush 间谍封装为准对齐请求构造方式——文件里已有 trigger 路径测试可照抄其 mock 骨架；上面只给出断言意图，封装照现有。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run lib/push/__tests__/push-api.test.ts`
Expected: FAIL（runPush 未收到 presetId/selfTest 语义）

- [ ] **Step 3: 改 route.ts trigger 段**

在 `const firstTime = isFirstTrigger(body.workflowId);` 附近（L439-444）改为：

```typescript
  // 首触发安全门：新 workflow 首触发先发给自己
  const firstTime = isFirstTrigger(body.workflowId);
  let finalSelector = selector;
  if (firstTime) {
    finalSelector = { kind: 'person', ids: [operatorId] };
  }
  // selfTest：模板编辑器「测试发送」——服务端强制发操作者本人，不信任前端 selector
  if ((body as Record<string, unknown>).selfTest === true) {
    finalSelector = { kind: 'person', ids: [operatorId] };
  }
```

runPush 调用处（L448-455）补透传：

```typescript
    const result = await runPush({
      workflowId: body.workflowId,
      presetId: (body as Record<string, unknown>).presetId as string | undefined,
      selector: finalSelector,
      operatorId,
      broadcastPerm,
      deliver: true,
      targetMode: ((body as Record<string, unknown>).targetMode as 'follow' | 'fixed') || undefined,
      targetId: (body as Record<string, unknown>).targetId as number | undefined,
      variables: (body as Record<string, unknown>).variables as Record<string, string> | undefined,
    });
```

同时 trigger 段顶部「selector required」校验对 selfTest 放宽（selfTest 时 selector 可省）：

```typescript
  if (!body.selector && !(body as Record<string, unknown>).selfTest) {
    return NextResponse.json({ ok: false, error: 'selector required' }, { status: 400 });
  }
```

（注意后续 `validateSelector(body.selector)` 在 selfTest 分支下用默认值跳过：`const selResult = body.selector ? validateSelector(body.selector) : { ok: true as const, value: { kind: 'person' as const, ids: [] } };`——selfTest 的最终 selector 由上面强制覆盖，不依赖此值。）

- [ ] **Step 4: 跑全部推送测试 + typecheck**

Run: `cd web && npx vitest run lib/push --reporter=default && npx tsc --noEmit`
Expected: 全 PASS / 0 错误

- [ ] **Step 5: Commit**

```bash
git add web/app/api/push/route.ts web/lib/push/__tests__/push-api.test.ts
git commit -m "feat(push): /api/push 加 presetId/selfTest/targetMode 透传（selfTest 强制本人）"
```

---

### Task 6: 调度 job 改造——读 push_configs + 守卫 + 回写

**Files:**
- Modify: `web/lib/jobs/scheduled-reports/manifest.ts`（run 函数整体替换为新链路）
- Test: `web/lib/push/__tests__/run-push.test.ts` 不涉；本 task 测试=集成验证（步骤内 curl/日志）

**Interfaces:**
- Consumes: T1 表 / T3 `matchesDate` / T4 `checkTargetActive, notifyOwnerOnce` / T5 `/api/push` presetId 参数
- Produces: job 每小时扫 enabled push_configs → 今日 due 且未跑 → 守卫 → POST /api/push（presetId+selector+userId=owner）→ 回写 last_run_txn_id/last_run_date

- [ ] **Step 1: 重写 manifest.ts 的 run（保留文件头注释与 JobManifest 结构，替换 get_due_scheduled_reports 旧链路）**

将 `run: async (): Promise<JobResult> => {...}` 整体替换为：

```typescript
  run: async (): Promise<JobResult> => {
    const JOB_KEY = '__scheduled_reports';
    if (!tryAcquireLock(runningTasks, JOB_KEY, '定时报表推送', { logSkip: true })) {
      return { status: 'skipped' };
    }

    try {
      console.log('[scheduler] 定时报表推送扫描开始');

      // 1) 拉 enabled 任务（PostgREST 直查 push_configs）
      const postgrestUrl = process.env.POSTGREST_URL || 'http://postgrest:3000';
      const pgHeaders = {
        apikey: process.env.INSFORGE_API_KEY || '',
        Authorization: `Bearer ${process.env.INSFORGE_API_KEY || ''}`,
        'Content-Type': 'application/json',
      };
      const resp = await fetch(`${postgrestUrl}/push_configs?enabled=eq.true&select=*`, { headers: pgHeaders });
      if (!resp.ok) {
        console.warn('[scheduled-reports] 查询 push_configs 失败:', resp.status);
        return { status: 'error', message: `查询失败: ${resp.status}` };
      }
      const configs = (await resp.json().catch(() => [])) as Array<{
        config_id: string; name: string; cron_spec: { kind: string; time: string; weekday?: number; day?: number };
        selector_json: { kind: string; ids?: string[] }; target_mode: 'follow' | 'fixed'; target_id: number | null;
        preset_id: string; owner_wecom_id: string; last_run_date: string | null;
      }>;
      if (!Array.isArray(configs) || configs.length === 0) {
        console.log('[scheduled-reports] 无启用任务');
        return { status: 'ok', message: '无任务' };
      }

      const today = new Date().toISOString().slice(0, 10);
      const results: Array<{ id: string; txnId?: string; skipped?: string; error?: string }> = [];

      for (const cfg of configs) {
        try {
          // 2) 今日 due 且未跑（当日内补发：错过整点下一小时补上，跨日不补）
          const due = matchesDate(cfg.cron_spec as CronSpec, new Date());
          const alreadyRan = cfg.last_run_date === today;
          if (!due || alreadyRan) continue;
          results.push({ id: cfg.config_id });

          // 3) 目标守卫：无进行中目标 → 跳过 + owner 一次性提醒
          const guard = await checkTargetActive(cfg.target_mode, cfg.target_id ?? undefined);
          if (!guard.active) {
            console.log(`[scheduled-reports] ${cfg.name} 跳过：${guard.reason}`);
            await notifyOwnerOnce({ configId: cfg.config_id, ownerWecomId: cfg.owner_wecom_id, name: cfg.name });
            results[results.length - 1].skipped = guard.reason;
            // 守卫跳过也记当日已处理（last_run_date），避免下一小时重复提醒扫描
            await fetch(`${postgrestUrl}/push_configs?config_id=eq.${cfg.config_id}`, {
              method: 'PATCH', headers: { ...pgHeaders, Prefer: 'return=minimal' },
              body: JSON.stringify({ last_run_date: today }),
            });
            continue;
          }

          // 4) 触发（presetId 显式传，workflow 统一 scheduled-report）
          const pushResult = await callRunPush({
            workflow_id: 'scheduled-report',
            operator_id: cfg.owner_wecom_id,
            selector: cfg.selector_json,
            preset_id: cfg.preset_id,
            target_mode: cfg.target_mode,
            target_id: cfg.target_id ?? undefined,
          });
          console.log(`[scheduled-reports] ${cfg.name} → txnId=${pushResult.txnId} groups=${pushResult.groups}`);
          results[results.length - 1].txnId = pushResult.txnId;

          // 5) 回写
          await fetch(`${postgrestUrl}/push_configs?config_id=eq.${cfg.config_id}`, {
            method: 'PATCH', headers: { ...pgHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ last_run_date: today, last_run_txn_id: pushResult.txnId }),
          });
        } catch (e: unknown) {
          console.error(`[scheduled-reports] ${cfg.name} 推送失败:`, (e as Error).message);
          results[results.length - 1].error = (e as Error).message;
        }
      }

      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        return { status: 'error', message: `${failed.length}/${results.length} 个任务失败`, detail: results };
      }
      return { status: 'ok', message: `${results.length} 个任务处理`, detail: results };
    } finally {
      const task = runningTasks.get(JOB_KEY);
      if (task) clearTimeout(task.timer), runningTasks.delete(JOB_KEY);
    }
  },
```

（`callRunPush` 的 `RunPushOpts` 内部接口同步加 `preset_id?: string; target_mode?: string; target_id?: number`，body 增对应 camelCase 字段 `presetId/targetMode/targetId`——照该文件现有 B3 修复的 camelCase 契约模式。`tryAcquireLock`/`runningTasks` 的 finally 清理照文件现有实现原样保留——若现有 run 尾部无 finally 清理，则保持与原实现一致，勿自创。）

manifest.ts 头部补 import：

```typescript
import { matchesDate, type CronSpec } from './cron-match';
import { checkTargetActive, notifyOwnerOnce } from '../../../push/target-guard';
```

（路径按实际层级：manifest.ts 在 `web/lib/jobs/scheduled-reports/`，target-guard 在 `web/lib/push/` → `../../push/target-guard`。以 tsc 通过为准。）

- [ ] **Step 2: typecheck + 现有 jobs 测试**

Run: `cd web && npx tsc --noEmit && npx vitest run lib/jobs --reporter=default`
Expected: 0 错误 / 全 PASS

- [ ] **Step 3: Commit**

```bash
git add web/lib/jobs/scheduled-reports/manifest.ts
git commit -m "feat(push): 调度切换 push_configs——cron_spec 匹配+目标守卫+txnId 回写（旧 scheduled_reports 链路退役）"
```

---

### Task 7: preset CRUD API + card_json 校验

**Files:**
- Create: `web/lib/push/preset-validate.ts`
- Create: `web/lib/push/__tests__/preset-validate.test.ts`
- Create: `web/app/api/admin/push-presets/route.ts`

**Interfaces:**
- Produces:
  - `validateCardJson(card: unknown): { ok: boolean; errors: string[] }` — 企微字段限制校验（Global Constraints 的限制表）
  - API：`GET /api/admin/push-presets`（列表含引用计数）、`POST`（新建/upsert，body `{preset_id?, name, msgtype='template_card', card_json}`）、`DELETE ?preset_id=`（被引用拒删）
- Consumes: `/api/push` 的 `checkPushPerm`（从 route.ts 导出或复制——若未导出则在本 route 内复制同款实现，以现仓库代码为准）

- [ ] **Step 1: 写校验失败测试**

```typescript
// web/lib/push/__tests__/preset-validate.test.ts
import { describe, it, expect } from 'vitest';
import { validateCardJson } from '../preset-validate';

describe('validateCardJson', () => {
  it('合法 news_notice 通过', () => {
    const card = {
      card_type: 'news_notice',
      main_title: { title: '📊 数据日报', desc: '销售 ¥1' },
      card_image: { url: 'https://x/banner.png', aspect_ratio: 2.25 },
      card_action: { type: 1, url: 'https://data.shanhaiyiguo.com/reports/targets' },
    };
    expect(validateCardJson(card)).toEqual({ ok: true, errors: [] });
  });
  it('缺必填（main_title/card_image/card_action）报错', () => {
    const r = validateCardJson({ card_type: 'news_notice' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('main_title');
    expect(r.errors.join()).toContain('card_image');
    expect(r.errors.join()).toContain('card_action');
  });
  it('超限：标题>128B / url>1024B / vertical>4 行 / aspect_ratio 越界', () => {
    expect(validateCardJson({
      card_type: 'news_notice',
      main_title: { title: 'x'.repeat(129) },
      card_image: { url: 'u', aspect_ratio: 1.3 },
      card_action: { type: 1, url: 'https://x/' + 'a'.repeat(1025) },
    }).ok).toBe(false);
    expect(validateCardJson({
      card_type: 'news_notice',
      main_title: { title: 't' },
      card_image: { url: 'u', aspect_ratio: 2.5 }, // >2.25
      card_action: { type: 1, url: 'https://x' },
    }).ok).toBe(false);
    expect(validateCardJson({
      card_type: 'news_notice',
      main_title: { title: 't' },
      card_image: { url: 'u', aspect_ratio: 1.3 },
      card_action: { type: 1, url: 'https://x' },
      vertical_content_list: Array.from({ length: 5 }, (_, i) => ({ title: 'k', value: String(i) })),
    }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败 → 实现校验**

```typescript
// web/lib/push/preset-validate.ts
// preset card_json 服务端校验（限制表：docs/ops/wecom-message-capabilities.md）

export function validateCardJson(card: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    return { ok: false, errors: ['card_json 必须是对象'] };
  }
  const c = card as Record<string, unknown>;
  const bytes = (s: unknown) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : 0);

  const title = (c.main_title as Record<string, unknown> | undefined)?.title;
  if (!c.main_title || !title) errors.push('main_title.title 必填');
  else if (bytes(title) > 128) errors.push('main_title.title >128 字节');

  const desc = (c.main_title as Record<string, unknown> | undefined)?.desc;
  if (desc && bytes(desc) > 512) errors.push('main_title.desc >512 字节');

  if (!c.card_image || !(c.card_image as Record<string, unknown>)?.url) errors.push('card_image.url 必填');
  else {
    const ar = Number((c.card_image as Record<string, unknown>).aspect_ratio);
    if (ar && (ar < 1.3 || ar > 2.25)) errors.push('card_image.aspect_ratio 须在 1.3~2.25');
  }

  if (!c.card_action || !(c.card_action as Record<string, unknown>)?.url) errors.push('card_action.url 必填');
  else if (bytes((c.card_action as Record<string, unknown>).url) > 1024) errors.push('card_action.url >1024 字节');

  const vcl = c.vertical_content_list;
  if (Array.isArray(vcl) && vcl.length > 4) errors.push('vertical_content_list 最多 4 行');
  const hcl = c.horizontal_content_list;
  if (Array.isArray(hcl) && hcl.length > 6) errors.push('horizontal_content_list 最多 6 行');

  return { ok: errors.length === 0, errors };
}
```

Run: `cd web && npx vitest run lib/push/__tests__/preset-validate.test.ts` → PASS

- [ ] **Step 3: 写 API route**

```typescript
// web/app/api/admin/push-presets/route.ts
// 模板库 CRUD（spec §4.3）：push:configure 闸 + card_json 校验 + 引用保护。
// PostgREST 直连模式（照 /api/admin/targets）。
import { NextRequest, NextResponse } from 'next/server';
import { validateCardJson } from '@/lib/push/preset-validate';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// checkPushPerm：与 /api/push 同款（若 /api/push 未导出，复制其实现：查 Casdoor/casbin 的人员权限）
async function checkPushPerm(userId: string, perm: string): Promise<boolean> {
  // ⚠️ 实现者：打开 web/app/api/push/route.ts 找到 checkPushPerm 函数，若 export 则 import；
  //   未 export 则把该函数及其依赖（如 RPC 调用）原样复制到本文件（保持同一权限判定，不得另写）。
  const { checkPushPerm: f } = await import('@/app/api/push/route');
  return f(userId, perm);
}

export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/push_message_presets?select=*,push_configs(count)&order=updated_at.desc`, { headers });
  const data = await r.json().catch(() => []);
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  // 权限闸：操作者身份从 cookie 会话取（照 /api/push 的 operator 模式——本路由操作者=登录用户）
  const operatorId = b.userId || '';
  if (!operatorId) return NextResponse.json({ ok: false, error: 'userId required' }, { status: 400 });
  if (!(await checkPushPerm(operatorId, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  if (!b.name || !b.card_json) return NextResponse.json({ ok: false, error: 'name/card_json required' }, { status: 400 });
  const v = validateCardJson(b.card_json);
  if (!v.ok) return NextResponse.json({ ok: false, error: 'card_json 校验失败', detail: v.errors }, { status: 400 });

  const presetId = b.preset_id || `preset-${Date.now().toString(36)}`;
  const r = await fetch(`${POSTGREST_URL}/push_message_presets`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      preset_id: presetId, name: b.name, msgtype: b.msgtype || 'template_card',
      card_json: b.card_json, enabled: b.enabled ?? true, updated_by: operatorId, updated_at: new Date().toISOString(),
    }),
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: `upsert failed: ${r.status}` }, { status: 502 });
  return NextResponse.json({ ok: true, preset_id: presetId });
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const presetId = url.searchParams.get('preset_id');
  const operatorId = url.searchParams.get('userId') || '';
  if (!presetId || !operatorId) return NextResponse.json({ ok: false, error: 'preset_id/userId required' }, { status: 400 });
  if (!(await checkPushPerm(operatorId, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  // 引用保护：被任务引用的模板不可删
  const refs = await fetch(`${POSTGREST_URL}/push_configs?preset_id=eq.${encodeURIComponent(presetId)}&select=config_id`, { headers });
  const refRows = await refs.json().catch(() => []);
  if (Array.isArray(refRows) && refRows.length > 0) {
    return NextResponse.json({ ok: false, error: `该模板被 ${refRows.length} 个推送任务引用，不可删除` }, { status: 409 });
  }
  const r = await fetch(`${POSTGREST_URL}/push_message_presets?preset_id=eq.${encodeURIComponent(presetId)}`, {
    method: 'DELETE', headers,
  });
  return NextResponse.json({ ok: r.ok });
}
```

（实现者注意：`push_configs(count)` 的嵌入计数若 PostgREST 版本不支持该形，改用两次查询——先列表再逐个查引用数，以实际 PostgREST 能力为准。`checkPushPerm` 的 import 路径以仓库实际导出情况为准。）

- [ ] **Step 4: typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: 0 错误

- [ ] **Step 5: Commit**

```bash
git add web/lib/push/preset-validate.ts web/lib/push/__tests__/preset-validate.test.ts web/app/api/admin/push-presets/route.ts
git commit -m "feat(push): 模板库 CRUD API——push:configure 闸 + 企微字段校验 + 引用保护"
```

---

### Task 8: 模板管理页（表单+点选+预览+测试发送）

**Files:**
- Create: `web/components/admin/push/CardPreview.tsx`
- Create: `web/app/admin/push/presets/page.tsx`
- Modify: `web/app/admin/layout.tsx`（导航加入口，照现有 admin 菜单模式）

**Interfaces:**
- Consumes: T7 API（GET/POST/DELETE）、T5 selfTest（POST /api/push `{workflowId:'scheduled-report', presetId, userId, selfTest:true}`）、T1 变量数据（GET /api/push `{action:'list_variables'}` 或直接 PostgREST `push_variables?enabled=eq.true&select=name,description,var_code`）
- Produces: 业务可用的模板编辑页

- [ ] **Step 1: CardPreview 组件（企微卡片 mock）**

```tsx
// web/components/admin/push/CardPreview.tsx
// 企微 template_card news_notice 预览 mock（只读渲染 card_json，样式贴近企微客户端）
'use client';

export interface PreviewCard {
  card_type?: string;
  source?: { desc?: string; desc_color?: number };
  main_title?: { title?: string; desc?: string };
  card_image?: { url?: string; aspect_ratio?: number };
  vertical_content_list?: Array<{ title?: string; value?: string }>;
  card_action?: { url?: string };
}

const SOURCE_COLORS = ['#888', '#333', '#e54f42', '#14ae67'];

export default function CardPreview({ card }: { card: PreviewCard }) {
  const ratio = card.card_image?.aspect_ratio ?? 1.3;
  return (
    <div className="w-[340px] rounded-xl bg-white shadow-md overflow-hidden border border-slate-200">
      {card.source?.desc && (
        <div className="px-3 pt-2 text-xs flex items-center gap-1.5" style={{ color: SOURCE_COLORS[card.source.desc_color ?? 0] }}>
          <span className="inline-block w-3 h-3 rounded-full bg-slate-300" />{card.source.desc}
        </div>
      )}
      <div className="px-3 py-2">
        <div className="text-base font-semibold text-slate-900">{card.main_title?.title || '（主标题）'}</div>
        {card.main_title?.desc && <div className="text-xs text-slate-500 mt-1">{card.main_title.desc}</div>}
      </div>
      {card.card_image?.url && (
        <img
          src={card.card_image.url}
          alt="卡片大图"
          className="w-full object-cover"
          style={{ aspectRatio: String(ratio) }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      )}
      {card.vertical_content_list?.length ? (
        <div className="px-3 py-2 space-y-1.5">
          {card.vertical_content_list.map((row, i) => (
            <div key={i} className="flex justify-between text-sm">
              <span className="text-slate-500">{row.title}</span>
              <span className="text-slate-900 font-medium tabular-nums">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {card.card_action?.url && (
        <div className="px-3 py-2 text-xs text-slate-400 truncate border-t border-slate-100">
          点击卡片跳转：{card.card_action.url}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 模板页（列表+编辑器+变量点选+测试发送）**

```tsx
// web/app/admin/push/presets/page.tsx
// 推送模板管理（spec §4.1）：列表 + 区域级表单编辑器 + 变量点选（通俗名）+ 实时预览 + 测试发自己。
'use client';
import { useState, useEffect, useCallback } from 'react';
import CardPreview, { type PreviewCard } from '@/components/admin/push/CardPreview';

interface VarRow { var_code: string; name: string; description: string }
interface PresetRow {
  preset_id: string; name: string | null; msgtype: string;
  card_json: PreviewCard | null; enabled: boolean;
  push_configs?: Array<{ count: number }>;
}

const emptyCard = (): PreviewCard => ({
  card_type: 'news_notice',
  source: { desc: '山海数据平台', desc_color: 1 },
  main_title: { title: '📊 数据日报', desc: '' },
  card_image: { url: 'https://data.shanhaiyiguo.com/push/daily-report-banner.png', aspect_ratio: 2.25 },
  vertical_content_list: [{ title: '销售额', value: '' }],
  card_action: { type: 1, url: 'https://data.shanhaiyiguo.com/reports/targets' },
});

export default function PushPresetsPage() {
  const [list, setList] = useState<PresetRow[]>([]);
  const [vars, setVars] = useState<VarRow[]>([]);
  const [editing, setEditing] = useState<{ preset_id?: string; name: string; card: PreviewCard } | null>(null);
  const [msg, setMsg] = useState('');
  // 操作者身份：admin 页登录态（照 admin/targets 的会话模式；无则要求手填，以仓库现有 admin 页取身份方式为准）
  const [operator, setOperator] = useState('ZhangDuo');

  const load = useCallback(async () => {
    const [p, v] = await Promise.all([
      fetch('/api/admin/push-presets', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/push', { method: 'POST', body: JSON.stringify({ action: 'list_variables' }) }).then((r) => r.json()),
    ]);
    setList(p.data || []);
    setVars((v.data || v.variables || []).filter((x: VarRow & { enabled?: boolean }) => x.enabled !== false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!editing) return;
    const r = await fetch('/api/admin/push-presets', {
      method: 'POST',
      body: JSON.stringify({ preset_id: editing.preset_id, name: editing.name, card_json: editing.card, userId: operator }),
    });
    const j = await r.json();
    setMsg(j.ok ? '已保存' : `保存失败：${j.error || ''} ${JSON.stringify(j.detail || '')}`);
    if (j.ok) { setEditing(null); load(); }
  };

  const selfTest = async () => {
    if (!editing) return;
    const r = await fetch('/api/push', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'scheduled-report', presetId: editing.preset_id || '__unsaved__', selector: { kind: 'person', ids: [operator] }, userId: operator, selfTest: true }),
    });
    const j = await r.json();
    setMsg(j.ok ? `测试已发送到你的企微（txnId ${j.txnId}）` : `测试失败：${j.error || ''}`);
  };

  const insertVar = (code: string, field: 'title' | 'desc', vIdx?: number) => {
    if (!editing) return;
    setEditing((e) => {
      if (!e) return e;
      const token = `{{${code}}}`;
      if (vIdx === undefined) {
        const mt = { ...e.card.main_title };
        (mt as Record<string, string>)[field] = ((mt as Record<string, string>)[field] || '') + token;
        return { ...e, card: { ...e.card, main_title: mt } };
      }
      const vcl = (e.card.vertical_content_list || []).map((row, i) => i === vIdx ? { ...row, [field === 'title' ? 'title' : 'value']: (field === 'title' ? row.title : row.value) + token } : row);
      return { ...e, card: { ...e.card, vertical_content_list: vcl } };
    });
  };

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-2">推送模板</h1>
      <p className="text-sm text-slate-500 mb-3">企微卡片模板库：配置区域与文案，点选指标变量，右侧实时预览。保存后可在「推送任务」里引用。</p>
      {msg && <div className="mb-2 text-sm text-primary">{msg}</div>}
      <button onClick={() => setEditing({ name: '', card: emptyCard() })} className="bg-primary text-white px-4 py-1 text-sm rounded-md mb-4">新建模板</button>

      {!editing && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <table className="w-full text-sm border-collapse">
            <thead><tr className="bg-slate-50">
              {['模板名', '类型', '启用', '被任务引用', '操作'].map((h) => <th key={h} className="border border-slate-200 p-2 text-left">{h}</th>)}
            </tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={5} className="border border-slate-200 p-2 text-slate-400 text-center">暂无模板</td></tr>}
              {list.map((p) => (
                <tr key={p.preset_id}>
                  <td className="border border-slate-200 p-2">{p.name || p.preset_id}</td>
                  <td className="border border-slate-200 p-2">{p.msgtype}</td>
                  <td className="border border-slate-200 p-2">{p.enabled ? '✓' : '—'}</td>
                  <td className="border border-slate-200 p-2">{p.push_configs?.[0]?.count ?? 0}</td>
                  <td className="border border-slate-200 p-2 space-x-2">
                    <button className="text-primary underline" onClick={() => setEditing({ preset_id: p.preset_id, name: p.name || '', card: p.card_json || emptyCard() })}>编辑</button>
                    <button className="text-red-500 underline" onClick={async () => {
                      if (!confirm(`删除模板「${p.name || p.preset_id}」？`)) return;
                      const r = await fetch(`/api/admin/push-presets?preset_id=${p.preset_id}&userId=${operator}`, { method: 'DELETE' });
                      const j = await r.json();
                      setMsg(j.ok ? '已删除' : `删除失败：${j.error || ''}`);
                      load();
                    }}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="flex gap-6 items-start">
          <div className="flex-1 rounded-lg border border-slate-200 bg-white p-4 space-y-3">
            <div>
              <label className="text-sm text-slate-600">模板名</label>
              <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如：每日销售日报" />
            </div>
            <div>
              <label className="text-sm text-slate-600">主标题</label>
              <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.card.main_title?.title || ''}
                onChange={(e) => setEditing({ ...editing, card: { ...editing.card, main_title: { ...editing.card.main_title, title: e.target.value } } })} />
            </div>
            <div>
              <label className="text-sm text-slate-600">副标题（可插变量）</label>
              <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.card.main_title?.desc || ''}
                onChange={(e) => setEditing({ ...editing, card: { ...editing.card, main_title: { ...editing.card.main_title, desc: e.target.value } } })} />
              <div className="flex flex-wrap gap-1 mt-1">
                {vars.map((v) => (
                  <button key={v.var_code} title={v.description}
                    onClick={() => insertVar(v.var_code, 'desc')}
                    className="px-2 py-0.5 text-xs rounded border border-slate-300 hover:border-primary hover:text-primary">
                    + {v.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-sm text-slate-600">键值行（0-4 行，值可插变量）</label>
              {(editing.card.vertical_content_list || []).map((row, i) => (
                <div key={i} className="flex gap-2 mb-1">
                  <input className="w-32 border border-slate-300 rounded-md px-2 py-1 text-sm" value={row.title || ''} placeholder="名称"
                    onChange={(e) => setEditing({ ...editing, card: { ...editing.card, vertical_content_list: (editing.card.vertical_content_list || []).map((r2, j) => j === i ? { ...r2, title: e.target.value } : r2) } })} />
                  <input className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm" value={row.value || ''} placeholder="值（点下方变量插入）"
                    onChange={(e) => setEditing({ ...editing, card: { ...editing.card, vertical_content_list: (editing.card.vertical_content_list || []).map((r2, j) => j === i ? { ...r2, value: e.target.value } : r2) } })} />
                  <button className="text-red-500 text-sm" onClick={() => setEditing({ ...editing, card: { ...editing.card, vertical_content_list: (editing.card.vertical_content_list || []).filter((_, j) => j !== i) } })}>✕</button>
                </div>
              ))}
              <div className="flex flex-wrap gap-1 mt-1">
                {vars.map((v) => (
                  <button key={v.var_code} title={v.description}
                    onClick={() => insertVar(v.var_code, 'value', 0)}
                    className="px-2 py-0.5 text-xs rounded border border-slate-300 hover:border-primary hover:text-primary">
                    + {v.name}
                  </button>
                ))}
              </div>
              {(editing.card.vertical_content_list?.length ?? 0) < 4 && (
                <button className="text-sm text-primary underline mt-1" onClick={() => setEditing({ ...editing, card: { ...editing.card, vertical_content_list: [...(editing.card.vertical_content_list || []), { title: '', value: '' }] } })}>+ 加一行</button>
              )}
            </div>
            <div>
              <label className="text-sm text-slate-600">整卡跳转链接</label>
              <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.card.card_action?.url || ''}
                onChange={(e) => setEditing({ ...editing, card: { ...editing.card, card_action: { ...editing.card.card_action, type: 1, url: e.target.value } } })} />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={save} className="bg-primary text-white px-4 py-1 text-sm rounded-md">保存</button>
              <button onClick={selfTest} className="border border-primary text-primary px-4 py-1 text-sm rounded-md" disabled={!editing.preset_id} title={editing.preset_id ? '' : '先保存再测试'}>测试发送到自己</button>
              <button onClick={() => setEditing(null)} className="px-4 py-1 text-sm text-slate-500">取消</button>
            </div>
          </div>
          <div className="w-[340px]"><CardPreview card={editing.card} /></div>
        </div>
      )}
    </div>
  );
}
```

（实现者注意：①operator 身份的取法以仓库现有 admin 页登录态模式为准对齐；②「高级区域」（引用块/左图右文）作为表单的可折叠段，结构与键值行同款增删模式，字段名照 wecom-message-capabilities.md §2.1——首版可只放 quote_area 一项，UI 位置在键值行下方。）

- [ ] **Step 3: admin 导航加入口**

`web/app/admin/layout.tsx` 的导航数组加 `{ href: '/admin/push/presets', label: '推送模板' }` 与 `{ href: '/admin/push/configs', label: '推送任务' }`（照现有菜单项结构）。

- [ ] **Step 4: 本地构建验证**

Run: `cd web && npm run build`
Expected: 构建成功（跨包 JSON 坑检查——本页无仓库外 JSON import）

- [ ] **Step 5: Commit**

```bash
git add web/components/admin/push/CardPreview.tsx web/app/admin/push/presets/page.tsx web/app/admin/layout.tsx
git commit -m "feat(push): 模板管理页——区域表单+变量点选（通俗名）+卡片实时预览+测试发自己"
```

---

### Task 9: config CRUD API

**Files:**
- Create: `web/app/api/admin/push-configs/route.ts`

**Interfaces:**
- Consumes: T7 的 checkPushPerm 模式
- Produces: `GET /api/admin/push-configs`（列表）、`POST`（新建/upsert：`{config_id?, name, cron_spec, selector, target_mode, target_id?, preset_id, enabled}`）、`PATCH ?config_id=`（启停：`{enabled}`）
- 校验：cron_spec（kind 枚举 / time 格式 HH:mm / weekly 有 weekday 1-7 / monthly 有 day 1-31）；selector（kind dept|person + ids）；target_mode=fixed 时 target_id 必填

- [ ] **Step 1: 写 API route**

```typescript
// web/app/api/admin/push-configs/route.ts
// 推送任务 CRUD（spec §4.3）：push:configure 闸 + cron_spec/selector/target 校验。
import { NextRequest, NextResponse } from 'next/server';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function checkPushPerm(userId: string, perm: string): Promise<boolean> {
  const { checkPushPerm: f } = await import('@/app/api/push/route');
  return f(userId, perm);
}

function validateSpec(b: Record<string, unknown>): string | null {
  if (!b.name) return 'name required';
  const cs = b.cron_spec as Record<string, unknown> | undefined;
  if (!cs || !['daily', 'weekly', 'monthly'].includes(String(cs.kind))) return 'cron_spec.kind 须为 daily/weekly/monthly';
  if (!/^\d{2}:\d{2}$/.test(String(cs.time))) return 'cron_spec.time 须为 HH:mm';
  if (cs.kind === 'weekly' && !(cs.weekday >= 1 && cs.weekday <= 7)) return 'weekly 须带 weekday 1-7';
  if (cs.kind === 'monthly' && !(cs.day >= 1 && cs.day <= 31)) return 'monthly 须带 day 1-31';
  const sel = b.selector as Record<string, unknown> | undefined;
  if (!sel || !['dept', 'person'].includes(String(sel.kind)) || !Array.isArray(sel.ids) || sel.ids.length === 0) {
    return 'selector 须为 dept/person + 非空 ids';
  }
  if (b.target_mode === 'fixed' && !b.target_id) return 'fixed 模式 target_id required';
  if (!b.preset_id) return 'preset_id required';
  return null;
}

export async function GET() {
  const r = await fetch(`${POSTGREST_URL}/push_configs?select=*&order=created_at.desc`, { headers });
  const data = await r.json().catch(() => []);
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b.userId) return NextResponse.json({ ok: false, error: 'userId required' }, { status: 400 });
  if (!(await checkPushPerm(b.userId, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  const err = validateSpec(b);
  if (err) return NextResponse.json({ ok: false, error: err }, { status: 400 });

  const body = {
    name: b.name, cron_spec: b.cron_spec, selector_json: b.selector,
    target_mode: b.target_mode || 'follow', target_id: b.target_id ?? null,
    preset_id: b.preset_id, owner_wecom_id: b.userId,
    enabled: b.enabled ?? true, updated_at: new Date().toISOString(),
  };
  const r = b.config_id
    ? await fetch(`${POSTGREST_URL}/push_configs?config_id=eq.${b.config_id}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
    : await fetch(`${POSTGREST_URL}/push_configs`, { method: 'POST', headers, Prefer: 'return=representation', body: JSON.stringify(body) });
  if (!r.ok) return NextResponse.json({ ok: false, error: `upsert failed: ${r.status}` }, { status: 502 });
  const row = b.config_id ? null : (await r.json())[0];
  return NextResponse.json({ ok: true, config_id: b.config_id || row?.config_id });
}

export async function PATCH(req: NextRequest) {
  const url = new URL(req.url);
  const configId = url.searchParams.get('config_id');
  const b = await req.json();
  if (!configId || !b.userId) return NextResponse.json({ ok: false, error: 'config_id/userId required' }, { status: 400 });
  if (!(await checkPushPerm(b.userId, 'push:configure'))) {
    return NextResponse.json({ ok: false, error: 'push:configure required' }, { status: 403 });
  }
  const r = await fetch(`${POSTGREST_URL}/push_configs?config_id=eq.${configId}`, {
    method: 'PATCH', headers, body: JSON.stringify({ enabled: !!b.enabled, updated_at: new Date().toISOString() }),
  });
  return NextResponse.json({ ok: r.ok });
}
```

（checkPushPerm 的复用方式同 T7 注记。）

- [ ] **Step 2: typecheck**

Run: `cd web && npx tsc --noEmit` → 0 错误

- [ ] **Step 3: Commit**

```bash
git add web/app/api/admin/push-configs/route.ts
git commit -m "feat(push): 推送任务 CRUD API——cron_spec/selector/target 校验 + 启停"
```

---

### Task 10: 任务管理页

**Files:**
- Create: `web/app/admin/push/configs/page.tsx`

**Interfaces:**
- Consumes: T9 API、T7 GET（模板下拉）、T3 `nextRunLabel`（前端 import 纯函数）、`/api/admin/targets`（目标下拉——fixed 模式选择用，GET 已有）
- Produces: 业务可用的任务编辑页

- [ ] **Step 1: 写页面**

```tsx
// web/app/admin/push/configs/page.tsx
// 推送任务管理（spec §4.2）：频率控件（业务不见 cron 表达式）+ 收件人 + 目标模式（默认勾「自动跟随」）+ 模板引用 + 启停。
'use client';
import { useState, useEffect, useCallback } from 'react';
import { nextRunLabel } from '@/lib/jobs/scheduled-reports/cron-match';

interface CronSpec { kind: 'daily' | 'weekly' | 'monthly'; time: string; weekday?: number; day?: number }
interface ConfigRow {
  config_id: string; name: string; cron_spec: CronSpec; enabled: boolean;
  selector_json: { kind: string; ids?: string[] }; target_mode: 'follow' | 'fixed'; target_id: number | null;
  preset_id: string; owner_wecom_id: string; last_run_txn_id: string | null;
}
const WEEK = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export default function PushConfigsPage() {
  const [list, setList] = useState<ConfigRow[]>([]);
  const [presets, setPresets] = useState<Array<{ preset_id: string; name: string | null }>>([]);
  const [targets, setTargets] = useState<Array<{ target_id: number; name: string; start_date: string; end_date: string; status: string }>>([]);
  const [editing, setEditing] = useState<Partial<ConfigRow> | null>(null);
  const [msg, setMsg] = useState('');
  const [operator, setOperator] = useState('ZhangDuo');

  const load = useCallback(async () => {
    const [c, p, t] = await Promise.all([
      fetch('/api/admin/push-configs', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/admin/push-presets', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/admin/targets', { cache: 'no-store' }).then((r) => r.json()),
    ]);
    setList(c.data || []);
    setPresets(p.data || []);
    setTargets((t.data || []).map((x: Record<string, number | string>) => ({
      target_id: Number(x.target_id), name: String(x.name), start_date: String(x.start_date), end_date: String(x.end_date), status: String(x.status),
    })));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!editing) return;
    const r = await fetch('/api/admin/push-configs', {
      method: 'POST',
      body: JSON.stringify({
        config_id: editing.config_id, name: editing.name,
        cron_spec: editing.cron_spec, selector: editing.selector_json,
        target_mode: editing.target_mode || 'follow', target_id: editing.target_id ?? null,
        preset_id: editing.preset_id, userId: operator,
      }),
    });
    const j = await r.json();
    setMsg(j.ok ? '已保存' : `保存失败：${j.error || ''}`);
    if (j.ok) { setEditing(null); load(); }
  };

  const spec = editing?.cron_spec || { kind: 'daily' as const, time: '08:30' };
  const setSpec = (patch: Partial<CronSpec>) => setEditing((e) => ({ ...e, cron_spec: { ...spec, ...patch } }));

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-2">推送任务</h1>
      <p className="text-sm text-slate-500 mb-3">配置「什么时间、推给谁、用哪个模板、看哪个目标的数据」。目标默认自动跟随当前进行中的；目标结束后任务自动暂停并提醒创建人。</p>
      {msg && <div className="mb-2 text-sm text-primary">{msg}</div>}
      <button onClick={() => setEditing({ cron_spec: { kind: 'daily', time: '08:30' }, selector_json: { kind: 'person', ids: [] }, target_mode: 'follow' })} className="bg-primary text-white px-4 py-1 text-sm rounded-md mb-4">新建任务</button>

      {!editing && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <table className="w-full text-sm border-collapse">
            <thead><tr className="bg-slate-50">
              {['任务名', '频率', '收件人', '目标', '模板', '启用', '最近 txnId', '操作'].map((h) => <th key={h} className="border border-slate-200 p-2 text-left">{h}</th>)}
            </tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={8} className="border border-slate-200 p-2 text-slate-400 text-center">暂无任务</td></tr>}
              {list.map((c) => (
                <tr key={c.config_id}>
                  <td className="border border-slate-200 p-2">{c.name}</td>
                  <td className="border border-slate-200 p-2">{nextRunLabel(c.cron_spec, new Date())}</td>
                  <td className="border border-slate-200 p-2">{c.selector_json.kind === 'dept' ? `部门×${c.selector_json.ids?.length ?? 0}` : `人员×${c.selector_json.ids?.length ?? 0}`}</td>
                  <td className="border border-slate-200 p-2">{c.target_mode === 'follow' ? '自动跟随' : `目标 #${c.target_id}`}</td>
                  <td className="border border-slate-200 p-2">{presets.find((p) => p.preset_id === c.preset_id)?.name || c.preset_id}</td>
                  <td className="border border-slate-200 p-2">{c.enabled ? '✓' : '—'}</td>
                  <td className="border border-slate-200 p-2 text-xs text-slate-400">{c.last_run_txn_id?.slice(0, 8) || '—'}</td>
                  <td className="border border-slate-200 p-2 space-x-2">
                    <button className="text-primary underline" onClick={() => setEditing(c)}>编辑</button>
                    <button className="text-slate-500 underline" onClick={async () => {
                      await fetch(`/api/admin/push-configs?config_id=${c.config_id}`, { method: 'PATCH', body: JSON.stringify({ userId: operator, enabled: !c.enabled }) });
                      load();
                    }}>{c.enabled ? '停用' : '启用'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 max-w-2xl space-y-3">
          <div>
            <label className="text-sm text-slate-600">任务名</label>
            <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.name || ''}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如：每日销售日报（东战区）" />
          </div>
          <div className="flex gap-2 items-end">
            <div>
              <label className="text-sm text-slate-600">频率</label>
              <select className="border border-slate-300 rounded-md px-2 py-1 text-sm" value={spec.kind}
                onChange={(e) => setSpec({ kind: e.target.value as CronSpec['kind'] })}>
                <option value="daily">每天</option><option value="weekly">每周</option><option value="monthly">每月</option>
              </select>
            </div>
            {spec.kind === 'weekly' && (
              <select className="border border-slate-300 rounded-md px-2 py-1 text-sm" value={spec.weekday ?? 1} onChange={(e) => setSpec({ weekday: Number(e.target.value) })}>
                {WEEK.map((w, i) => <option key={w} value={i + 1}>{w}</option>)}
              </select>
            )}
            {spec.kind === 'monthly' && (
              <input type="number" min={1} max={31} className="w-20 border border-slate-300 rounded-md px-2 py-1 text-sm" value={spec.day ?? 1} onChange={(e) => setSpec({ day: Number(e.target.value) })} />
            )}
            <div>
              <label className="text-sm text-slate-600">时间</label>
              <input type="time" className="border border-slate-300 rounded-md px-2 py-1 text-sm" value={spec.time} onChange={(e) => setSpec({ time: e.target.value })} />
            </div>
            <div className="text-xs text-slate-400 pb-1">{nextRunLabel(spec, new Date())} · 当日内错过自动补发</div>
          </div>
          <div>
            <label className="text-sm text-slate-600">收件人（人员 wecom_id，逗号分隔；部门选择器后续批次）</label>
            <input className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm"
              value={(editing.selector_json?.ids || []).join(',')}
              onChange={(e) => setEditing({ ...editing, selector_json: { kind: 'person', ids: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
              placeholder="ZhangDuo, WangSong" />
          </div>
          <div className="flex gap-4 items-center">
            <label className="text-sm text-slate-600 flex items-center gap-1">
              <input type="radio" checked={(editing.target_mode || 'follow') === 'follow'} onChange={() => setEditing({ ...editing, target_mode: 'follow' })} />
              自动跟随当前进行中的目标
            </label>
            <label className="text-sm text-slate-600 flex items-center gap-1">
              <input type="radio" checked={editing.target_mode === 'fixed'} onChange={() => setEditing({ ...editing, target_mode: 'fixed' })} />
              指定目标
            </label>
          </div>
          {editing.target_mode === 'fixed' && (
            <select className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.target_id ?? ''}
              onChange={(e) => setEditing({ ...editing, target_id: Number(e.target.value) })}>
              <option value="">选择目标…</option>
              {targets.map((t) => <option key={t.target_id} value={t.target_id}>{t.name}（{t.start_date}~{t.end_date}，{t.status}）</option>)}
            </select>
          )}
          <div>
            <label className="text-sm text-slate-600">消息模板</label>
            <select className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm" value={editing.preset_id || ''}
              onChange={(e) => setEditing({ ...editing, preset_id: e.target.value })}>
              <option value="">选择模板…</option>
              {presets.map((p) => <option key={p.preset_id} value={p.preset_id}>{p.name || p.preset_id}</option>)}
            </select>
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={save} className="bg-primary text-white px-4 py-1 text-sm rounded-md">保存</button>
            <button onClick={() => setEditing(null)} className="px-4 py-1 text-sm text-slate-500">取消</button>
          </div>
        </div>
      )}
    </div>
  );
}
```

（实现者注意：①收件人首版为人员 wecom_id 输入 + 部门选择器标注「后续批次」——spec 的部门树选择器是增强项，首版人员输入已覆盖张铎场景；②operator 身份取法同 T8 注记。）

- [ ] **Step 2: 本地构建验证**

Run: `cd web && npm run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add web/app/admin/push/configs/page.tsx
git commit -m "feat(push): 任务管理页——频率控件+收件人+目标模式（默认自动跟随）+模板引用+启停"
```

---

### Task 11: 部署与 E2E 生产验证

**Files:** 无代码（操作手册式验证）

- [ ] **Step 1: push 走 GHA 部署**

```bash
git push origin HEAD:main && gh run watch <run-id>
```
Expected: 5 steps 全绿；迁移 204 执行

- [ ] **Step 2: 部署后数据库验证**

```bash
ssh -i ~/.ssh/ShanHai-OPS.pem root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT var_code, name, description IS NOT NULL AS has_desc FROM push_variables ORDER BY var_code;\" -c '\\d push_configs'"
```
Expected: 7 行变量全有 description；push_configs 表结构完整

- [ ] **Step 3: E2E——建模板+建任务+到点触发**

1. 张铎打开 `https://data.shanhaiyiguo.com/admin/push/presets` → 新建模板（主标题「📊 数据日报」，副标题点选「销售额」「销售达成率」变量，键值行 2 行）→ 保存 → 「测试发送到自己」→ 企微收到 news_notice 卡片 ✅
2. 打开 `/admin/push/configs` → 新建任务（每天 当前时间+2分钟，收件人 ZhangDuo，目标=自动跟随，模板=刚才的）→ 保存
3. 等待 job 下一整点扫描（`docker logs deploy-web-1 --since 10m | grep scheduled-reports`）
Expected: 日志见 `任务 → txnId=... groups=1`；张铎企微收到定时推送卡片 ✅；管理页列表「最近 txnId」非空 ✅

- [ ] **Step 4: 守卫 E2E（可选，结束提醒验证）**

临时建 fixed 任务指向已 closed 的 7 月目标（target_id 从 `/api/admin/targets` 列表取 status=closed 的）→ 等扫描 →
Expected: 日志见「跳过：目标…已结束」；张铎收到一次性暂停提醒企微；一小时内再扫不重复提醒

- [ ] **Step 5: 回归确认**

- 手动 `POST /api/push`（不带 presetId，workflowId=scheduled-report）仍走旧 preset 兼容路径 → 张铎收到卡片（向后兼容不回归）
- `cd web && npx vitest run lib/push lib/jobs --reporter=default` 全绿

- [ ] **Step 6: 收尾 commit（若 E2E 中有小修）+ 汇报**

---

## Self-Review 记录

- **Spec 覆盖**：§3 表结构/取值/守卫/变量（T1/T2/T4）✅；§4 管理页与 API（T7/T8/T9/T10）✅；§5 调度（T3/T6）✅；§6 测试（各 task TDD 步骤+T11 回归）✅；高级区域（引用块/左图右文）——T8 注记「首版 quote_area 可折叠段」，覆盖方式为扩展位 ✅
- **占位符**：无 TBD/TODO；两处「实现者注意」是对仓库现状的对齐指令（checkPushPerm 导出形态、operator 身份取法），非留白
- **类型一致性**：CronSpec（T3 定义，T6/T10 同名同形）；TargetMode 'follow'|'fixed'（T2/T4/T5/T6/T9 一致）；presetId camelCase（route/API）与 preset_id snake_case（DB）转换点在 T5/T7/T9 明确
- **既有测试回归风险**：§12.1 回归测试断言 `order=start_date.desc` 与 `limit=1`——新实现为 `order=start_date.desc,end_date.asc`（含该子串）与 `limit=1`，兼容通过（T2 Step 4 已标注）
