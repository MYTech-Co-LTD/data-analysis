import { defineConfig } from 'vitest/config';
import path from 'node:path';

// C2（前端守护 P0）：给 vitest 加 @ 别名解析（与 tsconfig paths 对齐）。
// 之前 vi.mock("@/lib/api") 能工作是因为 mock factory 自己出实现、不走真实解析；
// 但加了 alias 后，被测代码顶层的 `import xx from "@/lib/..."` 也能正确解析到 web 根，
// 测试更稳健（不至于因某条 import 没被 mock 就整体崩）。
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    environment: 'node',
    // F2.1: 加 app/**/*.test.ts 让 route handler 测试也被 vitest 收集
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    exclude: ['tests/**', 'node_modules/**'],
  },
});
