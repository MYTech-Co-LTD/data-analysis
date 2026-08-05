// web/lib/report-center/__tests__/brand-metric.test.ts
// Task 1: 验证 getBrandMetric 返 GetterResult（ok / no-data / error 三态），
// 不再返裸 [] 把"出错"和"真无数据"混为一谈。
//
// 注：vitest 不解析 tsconfig 的 @/* 别名（无 vite-tsconfig-paths 插件），
// 但 vi.mock 的 specifier 必须与 brand-metric.ts 里写的 import 路径（"@/lib/api"）一致，
// 否则拦截不到；mock factory 自身提供实现，不再走真实解析。
// 真实代码链路是 client.database.from(...).select(...).eq(...).order(...) → { data, error }，
// mock 链必须匹配；3 个断言（r.status / r.rows / r.error）按 task-1-brief verbatim。
import { describe, it, expect, vi } from "vitest";
import { getBrandMetric } from "../brand-metric";

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

// 构造 PostgREST 风格 client：client.database.from(...).select(...).eq(...).order(...) → { data, error }
function makeClient(data: unknown, error: unknown) {
  return {
    database: {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: () => ({ data, error }),
          }),
        }),
      }),
    },
  };
}

describe("getBrandMetric", () => {
  it("returns okResult when rows present", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeClient(
        [
          {
            system_book_code: "3120",
            sale_amount: 100,
            sale_target: 80,
            sale_rate: 1.25,
            delivery_amount: 50,
            delivery_profit: 10,
            delivery_margin: 0.2,
            brand_name: "熊喵",
          },
        ],
        null
      )
    );
    const r = await getBrandMetric(1);
    expect(r.status).toBe("ok");
    expect(r.rows).toHaveLength(1);
  });

  it("returns no-data when empty", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(makeClient([], null));
    const r = await getBrandMetric(1);
    expect(r.status).toBe("no-data");
  });

  it("returns error (not []) on fetch failure", async () => {
    const { getClient } = await import("@/lib/api");
    (getClient as any).mockResolvedValue(
      makeClient(null, { message: "boom", code: "PGRST123" })
    );
    const r = await getBrandMetric(1);
    expect(r.status).toBe("error");
    expect(r.error).toBeDefined();
    expect(r.rows).toEqual([]); // 不再裸 []，而是 errorResult
  });
});
