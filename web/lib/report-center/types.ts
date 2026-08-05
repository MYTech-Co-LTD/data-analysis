// web/lib/report-center/types.ts
// GetterResult：所有 report-center getter 的统一返回类型。
// - 把"裸 [] = 出错"和"裸 [] = 真无数据"两种语义分开（status: ok | no-data | error）
// - error 分支带 AppError，方便上层决定 toast / 重试 / 占位
import type { AppError } from "@/lib/error";

export type GetterStatus = "ok" | "no-data" | "error";

export interface GetterResult<T> {
  rows: T[];
  status: GetterStatus;
  error?: AppError;
}

// 工厂：成功返回的行数决定 status
export function okResult<T>(rows: T[]): GetterResult<T> {
  return { rows, status: rows.length > 0 ? "ok" : "no-data" };
}

export function errorResult<T>(rows: T[] | undefined, error: AppError): GetterResult<T> {
  return { rows: rows ?? [], status: "error", error };
}
