import { defineConfig, globalIgnores } from "eslint/config";

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // `_` 前缀参数 = 刻意预留的接口位（如 rate-limit.ts 的 policyFor(_host)）
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "node_modules/**",
    ".temp/**",
    ".evidence/**",
    "out/**",
    "build/**",
  ]),
]);
