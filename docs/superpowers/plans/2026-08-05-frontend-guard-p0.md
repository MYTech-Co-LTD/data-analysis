# 前端渲染层守护 P0（F1/F2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给报表前端加 F1（取数错误透传 + 部分降级）和 F2（RLS 裁剪 / can_see_cost 脱敏可见性标注），消除"查询失败伪装成无数据"和"店长把被裁合计误读为全量"两个最高静默风险。

**Architecture:** 数据 getter（`web/lib/report-center/*.ts`，server 端 RSC 调用）统一返回 `GetterResult<T> = {rows; status; error?}`；page.tsx 用 `Promise.allSettled` 聚合，单模块失败不挂整页；client 组件按 `status` 降级渲染（error=加载失败+重试）。F2 新建 `/api/me` route 复用 `decodeJwtPayload` 解码 cookie JWT 返 `{branch_nums, can_see_cost}`，前端据此显示 RLS 横幅 + 脱敏列角标。

**Tech Stack:** Next.js 15（RSC + client components）/ TypeScript / vitest（单元，`web/lib/report-center/__tests__/`）/ Playwright（E2E，`web/tests/`）

**Spec:** `docs/superpowers/specs/2026-08-05-frontend-rendering-guard-design.md`

## Global Constraints
- TypeScript strict；复用 `web/lib/error.ts` 的 `wrapError`/`AppError`，不另造错误类型。
- 对齐 `DESIGN.md`：标注/横幅用 slate 中性色 + 现有 `data_status` 徽章同位视觉语言，不引入新设计系统。
- RSC 边界：getter 在 server 跑（page.tsx 是 RSC），返回给 client 组件的数据必须可序列化（`AppError` 是 plain object，OK）；重试用 `router.refresh()`（client）。
- 外部系统数据字段用 TEXT（本计划不涉及 DB，但若 `/api/me` 将来查 DB 需遵守）。
- 幂等：纯前端改动，无迁移；部署走 GHA（改 `web/`）。

## File Structure
| 文件 | 责任 | 动作 |
|---|---|---|
| `web/lib/report-center/types.ts` | `GetterResult<T>` 统一返回类型 | 新建 |
| `web/lib/report-center/{brand-metric,region-breakdown,category-summary,supply-chain-outbound,wholesale-daily,item-breakdown,target-snapshot}.ts` | 7 个数据 getter 返 `GetterResult` | 改 |
| `web/lib/report-center/targets.ts` | `getTargetKpi` 不再 throw，返 `GetterResult` | 改 |
| `web/lib/report-center/item-breakdown.ts` | `toBoard` 脱敏 profit bug | 改 |
| `web/app/reports/targets/[id]/page.tsx` | `Promise.allSettled` + 部分降级统计 + 透传 status/error | 改 |
| `web/app/reports/targets/[id]/error.tsx` | 模块级 error boundary（保留报表上下文） | 新建 |
| `web/app/api/me/route.ts` | 解码 JWT 返 `{branch_nums, can_see_cost}` | 新建 |
| `web/components/report-center/{brand-metric-table,…}.tsx` | 接 `status/error` 降级渲染 + 脱敏列角标 | 改 |
| `web/components/report-center/permission-banner.tsx` | RLS 裁剪横幅 | 新建 |
| `web/lib/report-center/__tests__/{brand-metric,item-breakdown}.test.ts` | getter/toBoard 单测 | 新建/改 |
| `web/tests/report-data.spec.ts` | F1/F2 E2E 断言 | 新建 |

---

### Task 1: 定义 GetterResult 类型 + 改造 getBrandMetric（建立模式）

**Files:**
- Create: `web/lib/report-center/types.ts`
- Modify: `web/lib/report-center/brand-metric.ts:19-37`
- Test: `web/lib/report-center/__tests__/brand-metric.test.ts`

**Interfaces:**
- Produces: `GetterResult<T>` 类型（后续所有 getter 用）；`getBrandMetric(targetId, closed?): Promise<GetterResult<BrandMetricRow>>`

- [ ] **Step 1: 写 GetterResult 类型**

Create `web/lib/report-center/types.ts`:
```ts
import type { AppError } from '@/lib/error';

export type GetterStatus = 'ok' | 'no-data' | 'error';

export interface GetterResult<T> {
  rows: T[];
  status: GetterStatus;
  error?: AppError;
}

// 工厂：成功返回的行数决定 status
export function okResult<T>(rows: T[]): GetterResult<T> {
  return { rows, status: rows.length > 0 ? 'ok' : 'no-data' };
}

export function errorResult<T>(rows: T[] | undefined, error: AppError): GetterResult<T> {
  return { rows: rows ?? [], status: 'error', error };
}
```

- [ ] **Step 2: 写失败测试**

Create `web/lib/report-center/__tests__/brand-metric.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { getBrandMetric } from '../brand-metric';

vi.mock('@/lib/api', () => ({
  getClient: vi.fn(),
  getSnapshotRows: vi.fn(() => null),
}));

describe('getBrandMetric', () => {
  it('returns okResult when rows present', async () => {
    const { getClient } = await import('@/lib/api');
    (getClient as any).mockResolvedValue({
      from: () ({ select: () ({ eq: () ({ data: [{ system_book_code: '3120', sale_amount: 100, sale_target: 80, sale_rate: 1.25, delivery_amount: 50, delivery_profit: 10, delivery_margin: 0.2, brand_name: '熊喵' }], error: null }) })),
    });
    const r = await getBrandMetric(1);
    expect(r.status).toBe('ok');
    expect(r.rows).toHaveLength(1);
  });

  it('returns no-data when empty', async () => {
    const { getClient } = await import('@/lib/api');
    (getClient as any).mockResolvedValue({
      from: () ({ select: () ({ eq: () ({ data: [], error: null }) })),
    });
    const r = await getBrandMetric(1);
    expect(r.status).toBe('no-data');
  });

  it('returns error (not []) on fetch failure', async () => {
    const { getClient } = await import('@/lib/api');
    (getClient as any).mockResolvedValue({
      from: () ({ select: () ({ eq: () ({ data: null, error: { message: 'boom', code: 'PGRST123' } }) })) }),
    });
    const r = await getBrandMetric(1);
    expect(r.status).toBe('error');
    expect(r.error).toBeDefined();
    expect(r.rows).toEqual([]); // 不再裸 []，而是 errorResult
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd web && npx vitest run lib/report-center/__tests__/brand-metric.test.ts`
Expected: FAIL（status 是 undefined，因 getBrandMetric 仍返裸数组）

- [ ] **Step 4: 改 getBrandMetric 返 GetterResult**

Modify `web/lib/report-center/brand-metric.ts`：导入 + 改签名 + 改返回。把 `:19-37` 的 `return [...]` 和 `console.error+return []` 改为：
```ts
import { getClient } from '@/lib/api';
import { wrapError } from '@/lib/error';
import { okResult, errorResult, type GetterResult } from './types';
import type { BrandMetricRow } from './brand-metric'; // 若接口在本文件内则不用 import

export async function getBrandMetric(targetId: number, closed?: boolean): Promise<GetterResult<BrandMetricRow>> {
  const client = await getClient();
  try {
    // ...原有 closed 分支读 snapshot（返回时包 okResult）
    const { data, error } = await client.from('report_brand_metric_gen').select('...').eq('target_id', targetId);
    if (error) throw error;
    return okResult((data ?? []) as BrandMetricRow[]);
  } catch (e) {
    console.error('brand_metric fetch:', e);
    return errorResult<BrandMetricRow>([], wrapError(e));
  }
}
```
> 注：保留原有 closed 分支与 select 字段不变，只把所有 `return X` 改 `return okResult(X)`、`return []` 改 `return errorResult([], wrapError(e))`。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd web && npx vitest run lib/report-center/__tests__/brand-metric.test.ts`
Expected: PASS（3 用例绿）

- [ ] **Step 6: Commit**

```bash
git add web/lib/report-center/types.ts web/lib/report-center/brand-metric.ts web/lib/report-center/__tests__/brand-metric.test.ts
git commit -m "feat(report): GetterResult type + getBrandMetric 返 status/error (F1.1)"
```

---

### Task 2: 改造其余 6 个数据 getter 为 GetterResult（同模式批量）

**Files:**
- Modify: `web/lib/report-center/region-breakdown.ts:47-48`、`category-summary.ts:41-42`、`supply-chain-outbound.ts:47-48`、`wholesale-daily.ts:37-38,71-72`、`item-breakdown.ts:80,105,127,141,220-221`、`target-snapshot.ts:18`

**Interfaces:**
- Consumes: `GetterResult`/`okResult`/`errorResult` from Task 1
- Produces: 6 个 getter 签名变为 `Promise<GetterResult<相应Row>>`

**模式（每个 getter 重复此改造，照 Task 1 的 brand-metric）：**
1. 导入 `{ okResult, errorResult, type GetterResult }` from `./types`、`wrapError` from `@/lib/error`。
2. 签名返回类型改为 `Promise<GetterResult<XxxRow>>`。
3. 把函数体内每个 `return someArray` / `return [...rows]` 改为 `return okResult(someArray)`。
4. 把每个 `console.error(...); return []`（或 `return empty` / `return { rows: [], total: 0 }` / `return null`）改为 `console.error(...); return errorResult([], wrapError(e))`。
   - `item-breakdown.ts` 的 `getItemBreakdownTop` 返回的是 `{ rows, totalAmount, totalProfit, defaultDay }` 结构——把该结构整体包进 GetterResult：`return { rows: [], status: 'error', error: wrapError(e), totalAmount: 0, totalProfit: ..., defaultDay }`，或更简单：先统一成 `GetterResult<ItemTopRow>`，把 `totalAmount/totalProfit/defaultDay` 作为附加字段挂在 GetterResult 上（扩展 `ItemBreakdownResult extends GetterResult<ItemTopRow> { totalAmount; totalProfit; defaultDay }`）。**推荐后者**：在 `item-breakdown.ts` 内 `export interface ItemBreakdownResult extends GetterResult<ItemTopRow> { totalAmount: number|null; totalProfit: number|null; defaultDay: string }`。
   - `target-snapshot.ts:18` 的 `return null` 改 `errorResult([], wrapError(error ?? new Error('snapshot null')))`；调用方（各 getter 的 closed 分支）需相应处理 GetterResult（见 Task 1 closed 分支注释）。

- [ ] **Step 1: 逐文件改造**（region → category → supply-chain → wholesale-daily → item-breakdown → target-snapshot）

每个文件照上述模式改。改完一个跑一次 typecheck：`cd web && npx tsc --noEmit`。

- [ ] **Step 2: 给 item-breakdown 加 error 分支单测（仿 Task 1 的 error 用例）**

在 `web/lib/report-center/__tests__/item-breakdown.test.ts` 加一条：mock `getClient` 返 `{ data: null, error: {...} }`，断言 `getItemBreakdownTop` 返 `status==='error'`。

- [ ] **Step 3: typecheck + 全量 vitest**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: PASS（无 type error，单测全绿）

- [ ] **Step 4: Commit**

```bash
git add web/lib/report-center/
git commit -m "feat(report): 6 getter 返 GetterResult，吞错改 status=error (F1.1)"
```

---

### Task 3: getTargetKpi 不再 throw，返 GetterResult

**Files:**
- Modify: `web/lib/report-center/targets.ts:18,34-40`
- Test: `web/lib/report-center/__tests__/targets.test.ts`

**Interfaces:**
- Produces: `getTargetKpi(targetId): Promise<GetterResult<TargetKpi>>`（不再 throw，page.tsx 不再因 KPI 失败挂整页）

- [ ] **Step 1: 写失败测试**（断言 error 时返 status=error 而非 throw）

```ts
import { describe, it, expect, vi } from 'vitest';
import { getTargetKpi } from '../targets';
vi.mock('@/lib/api', () => ({ getClient: vi.fn() }));

describe('getTargetKpi', () => {
  it('returns error result instead of throwing', async () => {
    const { getClient } = await import('@/lib/api');
    (getClient as any).mockResolvedValue({
      from: () ({ select: () ({ eq: () ({ data: null, error: { message: 'kpi boom' } }) })) }),
    });
    const r = await getTargetKpi(1);
    expect(r.status).toBe('error');
    expect(r.error).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd web && npx vitest run lib/report-center/__tests__/targets.test.ts` → FAIL（throw）

- [ ] **Step 3: 改 getTargetKpi**（targets.ts:34-40）

把 `if (error) throw error;` 改为：成功 `return okResult(data)`，catch `return errorResult([], wrapError(error))`。导入同 Task 1。`getTargetList`（:18）同理改返 GetterResult。

- [ ] **Step 4: 跑确认通过** — vitest PASS

- [ ] **Step 5: Commit**

```bash
git add web/lib/report-center/targets.ts web/lib/report-center/__tests__/targets.test.ts
git commit -m "feat(report): getTargetKpi 返 GetterResult 不再 throw (F1.2)"
```

---

### Task 4: page.tsx Promise.allSettled + 部分降级统计 + 透传 status/error

**Files:**
- Modify: `web/app/reports/targets/[id]/page.tsx:43-59,75-105`

**Interfaces:**
- Consumes: 所有 getter 现在返 `GetterResult`（Task 1-3）
- Produces: 透传给 `DesktopDashboard`/`MobileDashboard` 的 props 含 `status/error`；顶部渲染 `<PartialDegradeBanner>`（统计 error 数）

- [ ] **Step 1: 改 Promise.all → allSettled**

page.tsx:43-59 改为：
```ts
const results = await Promise.allSettled([
  getTargetKpi(targetId),
  getRegionBreakdown(id, closed),
  getCategorySummary(id, closed),
  getBrandMetric(targetId, closed),
  getItemBreakdownTop(targetId, closed),
  getSupplyChainOutbound(targetId, closed),
  getWholesaleDaily(targetId, closed),
]);
// allSettled 的 rejected 兜底（getter 内部已 catch，理论上不会 reject；防御性）
const pick = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
  r.status === 'fulfilled' ? r.value : fallback;
const kpi = pick(results[0], { rows: [], status: 'error' } as any);
const regionBreakdown = results[1].status === 'fulfilled' ? results[1].value : { rows: [], status: 'error' };
// ...同样解构其余 5 个
const failCount = [kpi, regionBreakdown, categorySummary, brandMetric, itemTop, supplyChain, wholesaleDaily]
  .filter((r: any) => r?.status === 'error').length;
```

- [ ] **Step 2: 顶部加部分降级横幅 + 透传 status/error**

page.tsx return 的 `<DesktopDashboard>`/`<MobileDashboard>` 前加：
```tsx
{failCount > 0 && (
  <PartialDegradeBanner failCount={failCount} total={7} />
)}
```
Dashboard props 透传各 getter 结果（已是 GetterResult，含 status/error），不再只传 rows。

- [ ] **Step 3: 新建 PartialDegradeBanner 组件**

Create `web/components/report-center/partial-degrade-banner.tsx`（client component，用 `useRouter` 提供重试）：
```tsx
'use client';
import { useRouter } from 'next/navigation';

export function PartialDegradeBanner({ failCount, total }: { failCount: number; total: number }) {
  const router = useRouter();
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800 flex items-center justify-between">
      <span>⚠️ {failCount}/{total} 个模块加载失败，部分数据不可用</span>
      <button onClick={() => router.refresh()} className="underline">重试全部</button>
    </div>
  );
}
```

- [ ] **Step 4: typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: build 成功（无 type error）

- [ ] **Step 5: Commit**

```bash
git add web/app/reports/targets/[id]/page.tsx web/components/report-center/partial-degrade-banner.tsx
git commit -m "feat(report): Promise.allSettled + 部分降级横幅，单模块失败不挂整页 (F1.2/1.4)"
```

---

### Task 5: 模块级 error boundary（保留报表上下文）

**Files:**
- Create: `web/app/reports/targets/[id]/error.tsx`

- [ ] **Step 1: 新建 error.tsx（参考 web/app/error.tsx 结构，但保留报表外壳）**

Create `web/app/reports/targets/[id]/error.tsx`:
```tsx
'use client';
import { getUserFriendlyMessage, isRetryable } from '@/lib/error';

export default function ReportError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const msg = getUserFriendlyMessage(error);
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
      <div className="text-red-600 text-3xl">⚠️</div>
      <h2 className="text-lg font-semibold">报表加载失败</h2>
      <p className="text-sm text-slate-600">{msg}</p>
      {isRetryable(error) && (
        <button onClick={reset} className="rounded bg-blue-600 px-4 py-2 text-sm text-white">重试</button>
      )}
      {process.env.NODE_ENV === 'development' && (
        <pre className="text-xs text-slate-400">{error.message}</pre>
      )}
    </div>
  );
}
```
> 与全局 `app/error.tsx` 区别：不渲染整页布局替换，只在报表段显示错误，保留 Header/Sidebar/报表名上下文。

- [ ] **Step 2: build 确认**

Run: `cd web && npm run build` → 成功

- [ ] **Step 3: Commit**

```bash
git add web/app/reports/targets/[id]/error.tsx
git commit -m "feat(report): 报表页模块级 error boundary 保上下文 (F1.5)"
```

---

### Task 6: 模块组件降级渲染（接 status/error）

**Files:**
- Modify: `web/components/report-center/brand-metric-table.tsx:7-11,101-107`（代表）+ 同模式改 `region-drill-table.tsx`、`category-summary.tsx`、`supply-chain-outbound-table.tsx`、`wholesale-daily-table.tsx`、`item-top-boards.tsx`、`kpi-cards.tsx`

**Interfaces:**
- Consumes: 各组件现在收到的 prop 是 `GetterResult<XxxRow>`（含 status/error），不再是裸 `rows: XxxRow[]`

- [ ] **Step 1: 改 brand-metric-table props + 降级渲染**

brand-metric-table.tsx:7-11 props 改为：
```ts
import type { GetterResult } from '@/lib/report-center/types';
import type { AppError } from '@/lib/error';
export function BrandMetricTable({ result, targetMonth, isMobile }: {
  result: GetterResult<BrandMetricRow>;
  targetMonth?: number; isMobile?: boolean;
}) {
  const { rows, status, error } = result;
```
空态分支 :101-107 改为三分支：
```tsx
if (status === 'error') {
  return <tbody><tr><td colSpan={7} className="py-8 text-center text-red-600">本模块加载失败（{error?.message}）<button onClick={() => router.refresh()} className="underline ml-2">重试</button></td></tr></tbody>;
}
if (rows.length === 0) {
  return <tbody><tr><td colSpan={7} className="py-8 text-center text-slate-400">暂无品牌数据</td></tr></tbody>;
}
```
（组件需 `'use client'` 才能用 `useRouter`；若该组件当前是 server component，则把"重试"提取到一个 client 子组件 `<RetryButton />`。）

- [ ] **Step 2: 同模式改其余 6 个组件**

每个组件：props 从 `rows: XxxRow[]` 改 `result: GetterResult<XxxRow>`；解构出 `status/error`；加 `status==='error'` 失败分支（"本模块加载失败+重试"），保留 `rows.length===0` 空态。

- [ ] **Step 3: 改 page.tsx / desktop.tsx / mobile.tsx 的 props 透传**

把 `<BrandMetricTable rows={brandMetric} />` 改为 `<BrandMetricTable result={brandMetric} />`（7 个组件调用点）。desktop.tsx:76 附近的 props 透传同步。

- [ ] **Step 4: typecheck + build**

Run: `cd web && npx tsc --noEmit && npm run build` → 成功

- [ ] **Step 5: Commit**

```bash
git add web/components/report-center/ web/app/reports/targets/[id]/
git commit -m "feat(report): 模块组件接 status/error 降级渲染 (F1.3)"
```

---

### Task 7: /api/me route（解码 JWT 返权限）

**Files:**
- Create: `web/app/api/me/route.ts`
- Test: `web/app/api/me/__tests__/route.test.ts`（或 vitest integration）

**Interfaces:**
- Produces: `GET /api/me` → `200 { branch_nums: string[]|'*', can_see_cost: boolean }` 或 `401`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { GET } from '../route';

describe('/api/me', () => {
  it('returns 401 without token', async () => {
    const res = await GET({} as any); // 无 cookie
    expect(res.status).toBe(401);
  });
  it('returns claims from token', async () => {
    // 构造一个 payload 含 branch_nums/can_see_cost 的 JWT（header.payload.sig，base64url）
    const payload = Buffer.from(JSON.stringify({ branch_nums: ['001'], can_see_cost: false })).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    const res = await GET({ headers: { cookie: `insforge_access_token=${token}` } } as any);
    const body = await res.json();
    expect(body.branch_nums).toEqual(['001']);
    expect(body.can_see_cost).toBe(false);
  });
});
```

- [ ] **Step 2: 跑确认失败** — `cd web && npx vitest run app/api/me` → FAIL（无 route）

- [ ] **Step 3: 实现 route**

Create `web/app/api/me/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { decodeJwtPayload } from '@/lib/monitor/jwt';

export async function GET(req: NextRequest) {
  const token = req.cookies.get('insforge_access_token')?.value;
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const claims = decodeJwtPayload(token.replace(/^Bearer\s+/, ''));
  if (!claims) return NextResponse.json({ error: 'invalid token' }, { status: 401 });
  return NextResponse.json({
    branch_nums: claims.branch_nums ?? '*',
    can_see_cost: claims.can_see_cost === true,
  });
}
```
> 复用 `web/lib/monitor/jwt.ts:2` 的 `decodeJwtPayload`（base64url 解码，不验签——只用于展示标注，鉴权由 PostgREST 层做）。

- [ ] **Step 4: 跑确认通过** — vitest PASS

- [ ] **Step 5: Commit**

```bash
git add web/app/api/me/ web/app/api/me/__tests__/
git commit -m "feat(report): /api/me 解码 JWT 返 branch_nums/can_see_cost (F2.1)"
```

---

### Task 8: 修 toBoard 脱敏 profit bug

**Files:**
- Modify: `web/lib/report-center/item-breakdown.ts:17-21,37-38,47`
- Test: `web/lib/report-center/__tests__/item-breakdown.test.ts`

**Interfaces:**
- Produces: `TopBoard.totalProfit: number | null`（脱敏时 null，不当 0）；`ItemTopRow.profit: number | null`

- [ ] **Step 1: 写失败测试**

```ts
describe('toBoard masked profit', () => {
  it('totalProfit is null when profit values are null (masked)', () => {
    const rows = [{ item_num: '1', amount: 100, profit: null }, { item_num: '2', amount: 50, profit: null }] as any;
    const board = toBoard(rows, 'amount', 'profit');
    expect(board.totalAmount).toBe(150);
    expect(board.totalProfit).toBeNull(); // 不再被 Number(null||0) 压成 0
  });
  it('totalProfit sums when profit present', () => {
    const rows = [{ item_num: '1', amount: 100, profit: 10 }, { item_num: '2', amount: 50, profit: 5 }] as any;
    const board = toBoard(rows, 'amount', 'profit');
    expect(board.totalProfit).toBe(15);
  });
});
```

- [ ] **Step 2: 跑确认失败** — vitest → FAIL（totalProfit 是 0 不是 null）

- [ ] **Step 3: 改 toBoard**

`item-breakdown.ts` TopBoard 接口 :17-21 把 `totalProfit: number` 改 `totalProfit: number | null`。toBoard :37-38 改：
```ts
const totalAmount = rows.reduce((s, r) => s + Number(r[amtKey] || 0), 0);
const profits = rows.map(r => r[profitKey]);
const totalProfit = profits.every(p => p == null) ? null : profits.reduce((s, p) => s + Number(p || 0), 0);
```
每行 profit :47 改 `profit: r[profitKey] == null ? null : Number(r[profitKey])`。

- [ ] **Step 4: 跑确认通过** — vitest PASS

- [ ] **Step 5: 修下游消费**（item-top-boards.tsx）

`item-top-boards.tsx:105-108` 把 `top20Profit`/`profitPct` 对 `totalProfit===null` 处理：`profitPct = totalProfit == null ? null : (totalProfit > 0 ? top20Profit/totalProfit : 0)`；显示用 `fmtProfit` 已对 0/null 返 "—"，但确保 null 透传。

- [ ] **Step 6: typecheck + vitest**

Run: `cd web && npx tsc --noEmit && npx vitest run` → PASS

- [ ] **Step 7: Commit**

```bash
git add web/lib/report-center/item-breakdown.ts web/components/report-center/item-top-boards.tsx web/lib/report-center/__tests__/item-breakdown.test.ts
git commit -m "fix(report): toBoard 脱敏 profit NULL 不当 0 累加 (F2.4)"
```

---

### Task 9: RLS 裁剪横幅

**Files:**
- Create: `web/components/report-center/permission-banner.tsx`
- Modify: `web/app/reports/targets/[id]/page.tsx`（顶部渲染）

**Interfaces:**
- Consumes: `/api/me`（Task 7）；判定 `branch_nums` 非空且非 `['*']`

- [ ] **Step 1: 新建 PermissionBanner（client，fetch /api/me）**

Create `web/components/report-center/permission-banner.tsx`:
```tsx
'use client';
import { useEffect, useState } from 'react';

export function PermissionBanner() {
  const [masked, setMasked] = useState(false);
  useEffect(() => {
    fetch('/api/me').then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return;
      const bn = d.branch_nums;
      setMasked(Array.isArray(bn) && bn.length > 0 && !(bn.length === 1 && bn[0] === '*'));
    }).catch(() => {});
  }, []);
  if (!masked) return null;
  return (
    <div className="rounded-md border border-slate-300 bg-slate-50 px-4 py-2 text-xs text-slate-600">
      ℹ️ 数据已按你的门店权限裁剪——「合计/战区/品牌」行仅含有权门店，非全量
    </div>
  );
}
```

- [ ] **Step 2: page.tsx 顶部渲染**

在 `<PartialDegradeBanner>` 旁加 `<PermissionBanner />`（page.tsx return 顶部）。

- [ ] **Step 3: build** — `cd web && npm run build` → 成功

- [ ] **Step 4: Commit**

```bash
git add web/components/report-center/permission-banner.tsx web/app/reports/targets/[id]/page.tsx
git commit -m "feat(report): RLS 裁剪横幅，店长可见合计标注为权限内 (F2.2)"
```

---

### Task 10: 脱敏列头角标 + tooltip

**Files:**
- Modify: `web/components/report-center/brand-metric-table.tsx:96-97`（列头）+ 同模式改其余含 profit/margin 列的组件（`item-top-boards.tsx:54,61`、`category-summary.tsx`、`supply-chain-outbound-table.tsx`、`wholesale-daily-table.tsx`）
- Create: `web/components/report-center/masked-badge.tsx`（角标小组件）

**Interfaces:**
- Consumes: `/api/me` 的 `can_see_cost`（通过同页面已 fetch 的权限状态，或 props 下传）

- [ ] **Step 1: 新建 MaskedBadge**

Create `web/components/report-center/masked-badge.tsx`:
```tsx
export function MaskedBadge() {
  return (
    <span className="ml-1 cursor-help text-slate-400" title="该列已按权限脱敏（can_see_cost=false），显示为 —">🚫</span>
  );
}
```

- [ ] **Step 2: 各 profit/margin 列头加角标（当 can_see_cost=false）**

brand-metric-table.tsx 列头 :96-97（销售/配送毛利列）：
```tsx
<th>{col.label}{costMasked && <MaskedBadge />}</th>
```
`costMasked` 由 props 下传（page.tsx fetch /api/me 后传给各组件），或各组件自 fetch（简化：统一由 page.tsx 顶层 fetch 一次，下传 `costMasked` prop）。**推荐 page.tsx fetch 一次权限，下传 `costMasked`/`branchMasked` 给所有组件**（避免 7 组件各 fetch）。

> 重构 Task 9 的 PermissionBanner：把 fetch 提到 page.tsx（RSC 不能 fetch client-side，所以用一个 client `<PermissionProvider>` 在顶部 fetch 一次，通过 context 或 props 下传）。**简化方案**：保持 PermissionBanner 自 fetch；`costMasked` 角标用一个 `<CostMaskedIndicator>` client 组件包在表格列头，自 fetch /api/me 缓存到 module 级变量（fetch 一次）。

- [ ] **Step 3: build + 手测**（can_see_cost=false 账号登录看列头角标）

- [ ] **Step 4: Commit**

```bash
git add web/components/report-center/masked-badge.tsx web/components/report-center/
git commit -m "feat(report): 脱敏列头角标+tooltip (F2.3)"
```

---

### Task 11: Playwright E2E 数据断言（F1 失败降级 + F2 标注）

**Files:**
- Create: `web/tests/report-data.spec.ts`
- Modify: `web/package.json`（加 `test:e2e` script）

- [ ] **Step 1: 新建 report-data.spec.ts（套用 mobile-smoke.spec.ts:7-10 cookie 注入）**

Create `web/tests/report-data.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
  await context.addCookies([{ name: 'insforge_access_token', value: 'dummy-test-token', domain: 'localhost', path: '/' }]);
});

test('F1: API 失败时显示模块降级而非空白', async ({ page }) => {
  await page.route('**/rest/v1/report_brand_metric_gen**', r => r.fulfill({ status: 500, body: '{}' }));
  await page.goto('/reports/targets/823');
  // 失败模块应显示"加载失败"，整页仍 200 渲染其它模块
  await expect(page.getByText(/加载失败|模块加载失败/)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/暂无|合计/)).toBeVisible(); // 其它模块或结构仍在
});

test('F2: RLS 横幅在限门店用户时显示', async ({ page }) => {
  // mock /api/me 返 branch_nums 非空
  await page.route('**/api/me', r => r.fulfill({ json: { branch_nums: ['001'], can_see_cost: true } }));
  await page.goto('/reports/targets/823');
  await expect(page.getByText(/按你的门店权限裁剪/)).toBeVisible({ timeout: 10000 });
});
```

- [ ] **Step 2: 加 test:e2e script**

`web/package.json` scripts 加：`"test:e2e": "playwright test"`。

- [ ] **Step 3: 跑 E2E**

Run: `cd web && npx playwright test report-data.spec.ts`
Expected: 2 用例绿（需 dev server 起，或 playwright config 的 webServer）

- [ ] **Step 4: Commit**

```bash
git add web/tests/report-data.spec.ts web/package.json
git commit -m "test(report): F1 降级 + F2 标注 E2E 断言 (F7)"
```

---

## Self-Review

**Spec coverage：**
- F1.1 getter 返 GetterResult → Task 1,2,3 ✅
- F1.2 Promise.allSettled + KPI 不抛 → Task 3,4 ✅
- F1.3 模块组件降级渲染 → Task 6 ✅
- F1.4 部分降级横幅 → Task 4 ✅
- F1.5 模块级 error boundary → Task 5 ✅
- F2.1 权限获取（/api/me）→ Task 7 ✅
- F2.2 RLS 横幅 → Task 9 ✅
- F2.3 脱敏列头角标 → Task 10 ✅
- F2.4 toBoard bug → Task 8 ✅
- F7 E2E → Task 11 ✅

**Placeholder scan：** 无 TBD/TODO；每个 step 含 code 或 exact diff。Task 2/6/10 是同模式批量，给了代表 + 模式描述（符合 writing-plans「重复模式描述一次 + 代表路径」）。Task 10 的权限下传有"简化方案"二选一，选了 module 级 fetch 缓存，明确。

**Type consistency：** `GetterResult<T>` 全程一致；`TopBoard.totalProfit: number | null`（Task 8）与 Task 6 item-top-boards 消费一致；`/api/me` 返回 `{branch_nums, can_see_cost}` 在 Task 9/10 一致。

**风险点：** Task 6 组件 server/client 边界（`useRouter`/`useEffect` 需 client）——plan 已注明提取 client 子组件。Task 4 allSettled 的 getter 已内部 catch 不会 reject，pick 是防御性。

## Verification（端到端）
- `cd web && npm test`（vitest 单元全绿）
- `cd web && npm run build`（构建通过）
- `cd web && npx playwright test`（E2E 绿）
- 手测：店长账号登录报表页看 RLS 横幅；can_see_cost=false 看 profit 列角标 + TOP 毛利合计"—"；临时改视图名让某 getter 失败看降级横幅 + 模块"加载失败"。
