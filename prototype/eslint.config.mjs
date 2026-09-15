import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // vinext／wrangler 的建置產物：跑過 build:vinext 之後才存在，
    // 不 ignore 的話 `pnpm run lint` 會多出數千筆產物噪音，結果隨建置狀態浮動。
    "dist/**",
    ".vinext/**",
    ".wrangler/**",
  ]),
]);

export default eslintConfig;
