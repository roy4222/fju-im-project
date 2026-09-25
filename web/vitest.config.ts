import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('./src', import.meta.url))
const serverOnlyStub = fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url))

const alias = [
  { find: /^@\/(.*)$/, replacement: `${src}/$1` },
  { find: /^server-only$/, replacement: serverOnlyStub },
]

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts', 'test/**/*.integration.test.ts'],
          environment: 'node',
          // 整套開始前建好 runtime 角色、設好測試密碼（只一次）。見 test/global-setup.ts。
          globalSetup: ['./test/global-setup.ts'],
          // 打真的 PostgreSQL，起連線比純運算慢。
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
