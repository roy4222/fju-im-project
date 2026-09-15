import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\/(.*)$/, replacement: `${src}/$1` }],
  },
  test: {
    projects: [
      {
        resolve: { alias: [{ find: /^@\/(.*)$/, replacement: `${src}/$1` }] },
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
