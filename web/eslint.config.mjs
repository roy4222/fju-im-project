import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import boundaries from 'eslint-plugin-boundaries'
import importPlugin from 'eslint-plugin-import'
import nextPlugin from '@next/eslint-plugin-next'
import fju from './eslint-rules/index.mjs'

/**
 * 分層邊界（母 spec §4.3、契約 02 §7）。
 *
 * `lint-fixtures/src/**` 是 S00-06 的七個反例與三個合法例，刻意鏡射 `src/**` 的目錄結構，
 * 讓同一套規則同時套用在正式程式與 fixtures 上；`pnpm lint:boundaries-test` 逐檔斷言
 * 「該被擋的被擋、理由正確，該放行的放行」。規則被改壞時那支測試會先紅。
 */
const elements = [
  { type: 'domain', pattern: ['src/domain/*', 'lint-fixtures/src/domain/*'], capture: ['module'] },
  { type: 'application', pattern: ['src/application/*', 'lint-fixtures/src/application/*'], capture: ['module'] },
  { type: 'infrastructure', pattern: ['src/infrastructure', 'lint-fixtures/src/infrastructure'] },
  { type: 'composition', pattern: ['src/composition', 'lint-fixtures/src/composition'] },
  { type: 'app', pattern: ['src/app', 'lint-fixtures/src/app'] },
  { type: 'shared', pattern: ['src/shared', 'lint-fixtures/src/shared'] },
]

/** §4.3 的「可以引用」矩陣。app（client）那一列由 fju/client-server-boundary 另外把關。 */
const layerMatrix = {
  domain: ['domain', 'shared'],
  application: ['domain', 'application', 'shared'],
  infrastructure: ['domain', 'application', 'infrastructure', 'shared'],
  app: ['app', 'application', 'composition', 'shared'],
  composition: ['domain', 'application', 'infrastructure', 'composition', 'shared'],
  shared: ['shared'],
}

/** application 與 shared 不可以碰框架與資料庫套件。 */
const frameworkPackages = [
  'next',
  'next/*',
  'react',
  'react-dom',
  'drizzle-orm',
  'drizzle-orm/*',
  'better-auth',
  'better-auth/*',
  'pg',
]

const policies = Object.entries(layerMatrix).map(([from, types]) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: types } } } },
}))

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { boundaries, import: importPlugin, fju },
    settings: {
      'boundaries/elements': elements,
      'boundaries/include': ['src/**/*', 'lint-fixtures/**/*'],
      'import/resolver': { typescript: { project: './tsconfig.json' }, node: true },
    },
    rules: {
      // 內部分層矩陣。外部套件的限制由 fju/external-packages 管（見下方逐層設定），
      // 所以這裡對 node_modules 一律放行。
      'boundaries/dependencies': [
        'error',
        { default: 'disallow', policies: [{ allow: { to: { module: { origin: 'external' } } } }, ...policies] },
      ],
      'import/no-cycle': ['error', { maxDepth: Infinity, ignoreExternal: true }],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Better Auth 的原生 API 只能由 S01-03 的包裝器呼叫。
              group: ['better-auth/api', 'better-auth/api/*', '**/infrastructure/auth/auth-instance*'],
              message: 'Better Auth 的 auth.api 只能由 infrastructure/auth/wrapper 呼叫（契約 03、S01-03）。',
            },
            {
              group: ['../../../../*'],
              message: '跨層請用 @/ 別名，不要用多層相對路徑繞過邊界規則。',
            },
          ],
        },
      ],
      'fju/client-server-boundary': 'error',
      'fju/actions-file-contract': 'error',
      // 母 spec §4.3：跨模組只能經公開入口 index.ts，而且只能 type-only
      //（執行期呼叫走 composition 注入的 port）。
      'fju/module-boundary': 'error',
    },
  },
  {
    // domain 是純 TypeScript，唯一允許的外部套件是 decimal.js（母 spec §4.3）。
    files: ['src/domain/**/*.ts', 'lint-fixtures/src/domain/**/*.ts'],
    rules: {
      'fju/external-packages': [
        'error',
        {
          mode: 'allowlist',
          packages: ['decimal.js'],
          message: 'domain 是純 TypeScript，唯一允許的外部套件是 decimal.js（母 spec §4.3）。',
        },
      ],
    },
  },
  {
    // application 與 shared 不可以碰框架與資料庫套件（母 spec §4.3）。
    files: [
      'src/application/**/*.ts',
      'src/shared/**/*.ts',
      'lint-fixtures/src/application/**/*.ts',
      'lint-fixtures/src/shared/**/*.ts',
    ],
    ignores: ['**/*.test.ts'],
    rules: {
      'fju/external-packages': [
        'error',
        {
          mode: 'denylist',
          packages: frameworkPackages,
          message: 'application 與 shared 不可引用 Next、React、Drizzle 或 Better Auth（母 spec §4.3）。',
        },
      ],
    },
  },
  {
    // 包裝器本身當然可以引用 Better Auth 的原生 API。
    files: ['src/infrastructure/auth/wrapper.ts', 'lint-fixtures/src/infrastructure/auth/wrapper.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // 實例檔要設定 `hooks.before`，需要 `better-auth/api` 的兩個「寫 hook 用」的匯出。
    // 這裡只放行這兩個名字——`auth.api.*` 的實際呼叫仍然只能在 wrapper（契約 03 §2）。
    files: ['src/infrastructure/auth/auth-instance.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['better-auth/api', 'better-auth/api/*'],
              // 四個都是「寫 hook 用」的匯出，不是 `auth.api.*` 的能力呼叫：
              // getAuthoritativeSessionFromCtx 只是在 hook 裡把 session 從 DB 讀回來，
              // 業務狀態閘門需要它（契約 03 §2）；getOAuthState 只讀這一趟 OAuth 的 state
              // （分辨登入還是連結，票 10 預授權老師綁定用）。
              allowImportNames: ['APIError', 'createAuthMiddleware', 'getAuthoritativeSessionFromCtx', 'getOAuthState'],
              message:
                '實例檔只能從 better-auth/api 取 APIError、createAuthMiddleware、getAuthoritativeSessionFromCtx 與 getOAuthState；auth.api 的呼叫在 wrapper。',
            },
            {
              group: ['../../../../*'],
              message: '跨層請用 @/ 別名，不要用多層相對路徑繞過邊界規則。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/composition/**/*.ts', 'src/infrastructure/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.integration.test.ts'],
    rules: { 'fju/server-only-header': 'error' },
  },
  {
    files: ['src/app/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    files: [
      '**/*.test.ts',
      '**/*.integration.test.ts',
      'test/**/*.ts',
      'e2e/**/*.ts',
      'eslint-rules/**/*.mjs',
      'scripts/**/*.mjs',
      // schema 產生器的設定入口：它的工作就是把實例建出來給 CLI 讀（見該檔說明）。
      'scripts/auth-schema-config.ts',
      '*.config.{ts,mjs}',
    ],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
    // 測試要同時打「經包裝器」與「繞過包裝器直接打 auth.handler」兩條路，才證明得了兩層攔截，
    // 所以測試檔可以 import auth-instance；正式碼仍然被 no-restricted-imports 擋著。
    rules: {
      'boundaries/dependencies': 'off',
      'fju/external-packages': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    // fixtures 是刻意寫壞的範例，不要因為「宣告沒用到」這種次要問題干擾斷言。
    files: ['lint-fixtures/**/*'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
