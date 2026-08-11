import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import importPlugin from "eslint-plugin-import";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 依赖方向铁律（spec 2026-08-11-modular-plugin-design §4.4；P1 起严执）：
  // web/lib/jobs/** 与 web/lib/report-center/boards/** 禁止互 import（插件边界），
  // 共享类型只经 web/lib/contracts 消费。jobs/boards 未建时为骨架（无命中），P1/P4 落地后即生效。
  {
    plugins: { import: importPlugin },
    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            { target: "./lib/jobs", from: "./lib/report-center/boards" },
            { target: "./lib/report-center/boards", from: "./lib/jobs" },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
