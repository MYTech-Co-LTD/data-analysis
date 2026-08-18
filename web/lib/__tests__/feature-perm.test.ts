// web/lib/__tests__/feature-perm.test.ts
// checkFeaturePerm 单模块（plan Task 3 Step 1，spec §6.2）：
// claims 命中 true / BREAKGLASS 命中 true+审计 / 双无 false。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkFeaturePerm, hasBoardPerm, hasKpiPerm, buildPermPool } from '../feature-perm';

afterEach(() => {
  delete process.env.BREAKGLASS_ADMINS;
  vi.restoreAllMocks();
});

describe('checkFeaturePerm', () => {
  it('claims 含权限 → true', async () => {
    expect(await checkFeaturePerm('u1', 'data-analysis:admin',
      { permissions: ['data-analysis:admin'] })).toBe(true);
  });

  it('无 claims 但在 BREAKGLASS → true 且记审计', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BREAKGLASS_ADMINS = 'u9';
    expect(await checkFeaturePerm('u9', 'data-analysis:admin')).toBe(true);
    expect(warn).toHaveBeenCalledWith('[breakglass]', 'u9', 'data-analysis:admin');
  });

  it('两者皆无 → false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await checkFeaturePerm('u1', 'data-analysis:admin', {})).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('hasBoardPerm / hasKpiPerm（看板/KPI 卡片级能力）', () => {
  it('具名命中 → true', () => {
    expect(hasBoardPerm(['data-analysis:view-board:kpi'], 'kpi')).toBe(true);
    expect(hasKpiPerm(['data-analysis:view-kpi:sale'], 'sale')).toBe(true);
  });
  it('命名空间通配 view-board:* / view-kpi:* → true', () => {
    expect(hasBoardPerm(['data-analysis:view-board:*'], 'region')).toBe(true);
    expect(hasKpiPerm(['data-analysis:view-kpi:*'], 'outbound_margin')).toBe(true);
  });
  it('全局 * 不再放行（去特权：Casdoor 空配置默认 *，防提权；2026-08-18）', () => {
    // 纯 '*'：该命名空间未配置化 → 仍走 fail-open 全开（与旧 token 同语义，非 '*' 特权）
    expect(hasBoardPerm(['*'], 'kpi')).toBe(true);
    // '*' 与具名配置并存 → 不扩展范围（未配的看板仍被收权）★防提权关键
    expect(hasBoardPerm(['*', 'data-analysis:view-board:kpi'], 'region')).toBe(false);
    expect(hasKpiPerm(['*', 'data-analysis:view-kpi:sale'], 'delivery')).toBe(false);
  });
  it('未配置任何该命名空间能力（旧 token/无登录）→ 默认全开（fail-open，避免上线即收权）', () => {
    expect(hasBoardPerm(undefined, 'kpi')).toBe(true);
    expect(hasBoardPerm([], 'kpi')).toBe(true);
    // 旧 token 有 20 个 view/field 等权限但不含 view-board → 全开（不因旧 token 误伤）
    expect(hasBoardPerm(['data-analysis:view:reports', 'data-analysis:field:cost'], 'region')).toBe(true);
    expect(hasKpiPerm(['data-analysis:view:reports'], 'sale')).toBe(true);
    // view:* 不等于 view-board:*（命名空间隔离）
    expect(hasBoardPerm(['data-analysis:view:kpi'], 'kpi')).toBe(true); // 但未配置 view-board → 仍全开
  });
  it('已配置部分能力 → 只裁剪到配置集（收权生效）', () => {
    const perms = ['data-analysis:view-board:kpi', 'data-analysis:view-board:region']; // 只配 2 看板
    expect(hasBoardPerm(perms, 'kpi')).toBe(true);
    expect(hasBoardPerm(perms, 'region')).toBe(true);
    expect(hasBoardPerm(perms, 'brand')).toBe(false);   // 未配的看板被收权
    expect(hasBoardPerm(perms, 'wholesale')).toBe(false);
    const kperms = ['data-analysis:view-kpi:sale', 'data-analysis:view-kpi:delivery'];
    expect(hasKpiPerm(kperms, 'sale')).toBe(true);
    expect(hasKpiPerm(kperms, 'outbound_amt')).toBe(false);
  });
  it('未知 boardId/code（单真相防御）→ false', () => {
    expect(hasBoardPerm(['data-analysis:view-board:*'], 'nonexistent')).toBe(false);
    expect(hasKpiPerm(['data-analysis:view-kpi:*'], 'nonexistent')).toBe(false);
  });
  it('方案甲：permissions 含组|label（Casdoor 下拉选中写入）→ 归一命中（防静默失效）', () => {
    // 管理员在 Casdoor 下拉选中组|label → permission.resources 里是「看板|指标概览」/「看板|门店零售」
    expect(hasBoardPerm(['看板|指标概览', 'data-analysis:view-board:region'], 'kpi')).toBe(true);
    // 组|label 收权：只配组|label → 未配的看板仍被收权（归一后命名空间已配置化）
    expect(hasBoardPerm(['看板|指标概览'], 'brand')).toBe(false);
  });
});

describe('buildPermPool 全量通俗名归一 + 覆盖视图注入（方案 C 统一视图/看板）', () => {
  it('通俗名 → key：具名能力（含 view:reports/brand/category/field/admin）', () => {
    const pool = buildPermPool(['看板|经营总览', '看板|目标达成', '品牌|熊喵鲜生', '品类|水果', '字段|成本可见', '门禁|管理台']);
    expect(pool.has('data-analysis:view:reports')).toBe(true);
    expect(pool.has('data-analysis:view:reports-targets')).toBe(true);
    expect(pool.has('data-analysis:brand:3120')).toBe(true);
    expect(pool.has('data-analysis:category:水果')).toBe(true);
    expect(pool.has('data-analysis:field:cost')).toBe(true);
    expect(pool.has('data-analysis:admin')).toBe(true);
  });

  it('看板能力通俗名 → 覆盖的报表视图 key 注入（报表授权 ⇒ 视图访问）', () => {
    const pool = buildPermPool(['看板|品牌×指标', '看板|外部批发']);
    expect(pool.has('data-analysis:view-board:brand')).toBe(true);
    expect(pool.has('data-analysis:view:report_brand_metric_gen')).toBe(true);   // 覆盖注入
    expect(pool.has('data-analysis:view-board:wholesale')).toBe(true);
    expect(pool.has('data-analysis:view:report_wholesale_customer_gen')).toBe(true);
    expect(pool.has('data-analysis:view:report_wholesale_daily_gen')).toBe(true);
    expect(pool.has('data-analysis:view:report_wholesale_daily_customer_gen')).toBe(true);
  });

  it('覆盖注入幂等：同 key 不重复', () => {
    const pool = buildPermPool(['看板|品牌×指标', 'data-analysis:view:report_brand_metric_gen']);
    expect([...pool].filter((k) => k === 'data-analysis:view:report_brand_metric_gen').length).toBe(1);
  });

  it('组通俗名「报表看板全组」→ 反查组 key → 展开成员', () => {
    const pool = buildPermPool(['看板|报表看板全组']);
    expect(pool.has('data-analysis:view:reports')).toBe(true);
    expect(pool.has('data-analysis:view:reports-targets')).toBe(true);
    expect(pool.has('data-analysis:view-group:reports-all')).toBe(false); // 组 key 被展开消费
  });

  it('看板覆盖注入对 hasBoardPerm 语义闭环：配看板即能访问对应报表视图', () => {
    // 页面级视图解析：permissions 里只有看板通俗名（无 view:reports）→ resolveViewKey 通过覆盖注入命中
    // （hasBoardPerm 本身看 view-board 命名空间；覆盖注入在 buildPermPool 层，供 resolveViewKey 复用）
    const pool = buildPermPool(['看板|门店战区']);
    expect(pool.has('data-analysis:view:report_region_breakdown_gen')).toBe(true);
  });
});
