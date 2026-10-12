import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  resolve: { alias: [{ find: /^@\/(.*)$/, replacement: `${src}/$1` }] },
  test: {
    environment: 'node',
    // 四類都要明列（拆票 S-1）：漏掉任何一類，那一類的測試沒跑 CI 也會綠。
    // collector/（S-3）與 proxy/（S-4）在各自的票合併前可以是空的。
    include: [
      'src/**/*.test.ts',
      'test/**/*.test.{ts,tsx}',
      'collector/**/*.test.mjs',
      'proxy/**/*.test.mjs',
      'verify-origin.test.mjs',
    ],
  },
})
