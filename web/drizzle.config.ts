import { defineConfig } from 'drizzle-kit'

// drizzle-kit 只用來「產生純 SQL」（契約 01 §12）；套用 migration 由 scripts/migrate.mjs
// 以 owner 連線執行，不用 drizzle-kit push。
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/db/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  migrations: { table: '__drizzle_migrations', schema: 'public' },
  dbCredentials: {
    url: process.env.DATABASE_URL_OWNER ?? 'postgres://fju_owner:fju_local_dev@127.0.0.1:55432/fju',
  },
})
