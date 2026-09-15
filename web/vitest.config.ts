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
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
})
