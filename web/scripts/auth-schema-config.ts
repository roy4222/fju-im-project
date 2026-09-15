/**
 * 給 Better Auth schema 產生器用的設定入口（`pnpm auth:generate`）。
 *
 * 產生器要的是一個**已經建好的** `auth` 物件，但正式碼的實例是延後建立的
 * （`next build` 收集路由設定時沒有 `DATABASE_URL`，見 auth-instance.ts）。
 * 這個檔只在產生 schema 時被載入——`scripts/auth-generate.mjs` 會先把 `DATABASE_URL`
 * 設成一個不連線的假值，所以這裡可以安全地把實例建出來。
 *
 * 刻意直接用正式的 `getAuth()`：這樣產生器看到的設定就是網站實際跑的設定，不會有第二份會走鐘的副本。
 */
import { getAuth } from '../src/infrastructure/auth/auth-instance'

export const auth = getAuth()
