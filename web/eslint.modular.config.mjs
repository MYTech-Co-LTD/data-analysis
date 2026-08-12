// web/eslint.modular.config.mjs
// 模块化依赖方向硬约束专用 lint 配置（spec 2026-08-11-modular-plugin-design §4.4）：
//   web/lib/jobs/** 与 web/lib/report-center/boards/** 禁止互 import（插件边界），共享类型只经 contracts。
// CI quality 单独跑本配置且必须通过——与全量 lint（警告模式）解耦：
//   存量 no-explicit-any 等 error 不阻断部署，但 jobs ⇄ boards 互 import 一旦出现即阻断（依赖方向硬约束）。
// 使用：npx eslint --config eslint.modular.config.mjs lib/jobs lib/report-center/boards
// 说明：alias 形态（@/lib/...）的互 import 由 scripts/guard-contract-drift.sh 兜底（grep 字面量），两者共同覆盖。
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

export default [
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    // 本配置只查依赖方向，其它规则全 off → 存量 eslint-disable 指令自然"未使用"，不报噪音
    linterOptions: { reportUnusedDisableDirectives: "off" },
    // 注册 @typescript-eslint 插件（规则默认 off）：兼容存量 /* eslint-disable @typescript-eslint */ 指令，
    // 未注册插件的命名空间 disable 会报 "Definition for rule ... was not found"。
    plugins: { import: importPlugin, "@typescript-eslint": tseslint.plugin },
    // resolver 设置与 eslint-config-next 对齐：node resolver 识别 .ts/.tsx 扩展，
    // 否则无扩展名相对 import（../xxx/manifest）解析失败，no-restricted-paths 不生效；
    // typescript resolver 负责 @/lib 别名解析。
    settings: {
      "import/parsers": {
        "@typescript-eslint/parser": [".ts", ".mts", ".cts", ".tsx", ".d.ts"],
      },
      "import/resolver": {
        node: { extensions: [".js", ".jsx", ".ts", ".tsx"] },
        typescript: { alwaysTryTypes: true },
      },
    },
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
];
