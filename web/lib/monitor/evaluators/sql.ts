// monitor evaluator 共享的 SQL 字面量转义。
// 不跨包复用 functions/_shared/fact-view.ts 的 sqlLit：那是 Deno edge function 运行时的模块，
// 被 Next.js web 侧 import 会造成错误的运行时耦合；两侧各留一份、各自单测锁定。
export function sqlLit(s: string): string {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
