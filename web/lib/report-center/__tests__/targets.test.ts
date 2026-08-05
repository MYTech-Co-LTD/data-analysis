// web/lib/report-center/__tests__/targets.test.ts
// Task 3: 验证 getTargetKpi / getTargetList 返 GetterResult（ok / no-data / error 三态），
// 不再 throw 把整页带崩（KPI 失败不再触发 error.tsx）。
//
// 注：vitest 不解析 tsconfig 的 @/* 别名（无 vite-tsconfig-paths 插件），
// 但 vi.mock 的 specifier 必须与 targets.ts 里写的 import 路径（"@/lib/api"）一致，
// 否则拦截不到；mock factory 自身提供实现，不再走真实解析。
//
// 真实链路：
//   getTargetKpi:  client.database.from(...).select(...).eq(...).eq(...) → { data, error }
//   getTargetList: client.database.from(...).select(...).eq(...)[.eq(...)].order(...).order(...) → { data, error }
// mock 链必须匹配。
import { describe, it, expect, vi } from "vitest";
import { getTargetKpi, getTargetList } from "../targets";

vi.mock("@/lib/api", () => ({
  getClient: vi.fn(),
}));

// wrapError 真实逻辑在它自己的单测里覆盖；本测试只关心 GetterResult 三态包装，
// 给个极简 stub（任何错误都返一个带 type 的 AppError 形对象）即可让 r.error toBeDefined。
vi.mock("@/lib/error", () => ({
  wrapError: (e: unknown) => ({
    type: "unknown",
    message: (e as { message?: string })?.message ?? "err",
    retry: true,
  }),
}));

// ---- getTargetKpi 链路：from().select().eq().eq() → { data, error } ----
function makeKpiClient(data: unknown, error: unknown) {
  return {
    database: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ data, error }),
          }),
        }),
      }),
    },
  };
}

// ---- getTargetList 链路：from().select().eq()[.eq()].order().order() → { data, error } ----
// 不带 status 时只调一次 eq；带 status 时调两次。用闭包计数。
function makeListClient(data: unknown, error: unknown) {
  return {
    database: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                order: () => ({ data, error }),
              }),
            }),
            // 第一次 eq 之后也能直接 order（不带 status 分支）
            order: () => ({
              order: () => ({ data, error }),
            }),
          }),
        }),
      }),
    },
  };
}

describe("getTargetKpi", () => {
  it("returns ok when rows present", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeKpiClient(
        [
          {
            target_id: 1,
            metric_code: "sale",
            target_level: "total",
            achievement_rate: 1.1,
          },
        ],
        null
      )
    );
    const r = await getTargetKpi(1);
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(1);
    expect(r.error).toBeUndefined();
  });

  it("returns no-data when empty", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(makeKpiClient([], null));
    const r = await getTargetKpi(1);
    expect(r.status).toBe("no-data");
    expect(r.rows).toEqual([]);
  });

  it("returns error result instead of throwing on fetch failure", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeKpiClient(null, { message: "kpi boom", code: "PGRST123" })
    );
    // 关键断言：不 throw，返 status=error
    const r = await getTargetKpi(1);
    expect(r.status).toBe("error");
    expect(r.error).toBeDefined();
    expect(r.rows).toEqual([]);
  });
});

describe("getTargetList", () => {
  it("returns ok with deduped summaries", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeListClient(
        [
          {
            target_id: 1,
            name: "T1",
            status: "active",
            target_type: "store",
            start_date: "2026-08-01",
            end_date: "2026-08-31",
            metric_code: "sale",
            achievement_rate: 0.9,
            progress_rate: 0.5,
          },
          // 同 target_id 第二行（不同 metric_code）→ 应被去重
          {
            target_id: 1,
            name: "T1",
            status: "active",
            target_type: "store",
            start_date: "2026-08-01",
            end_date: "2026-08-31",
            metric_code: "delivery",
            achievement_rate: 0.8,
            progress_rate: 0.5,
          },
        ],
        null
      )
    );
    const r = await getTargetList();
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].target_id).toBe(1);
    expect(r.rows[0].sample_metric).toBe("sale"); // 第一行优先
  });

  it("returns error result instead of throwing on fetch failure", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeListClient(null, { message: "list boom", code: "PGRST123" })
    );
    const r = await getTargetList("active");
    expect(r.status).toBe("error");
    expect(r.error).toBeDefined();
    expect(r.rows).toEqual([]);
  });
});
