import { describe, expect, it } from 'vitest'
import {
  ALLOWED_ROUTES,
  authPathFromUrl,
  BLOCKED_ROUTE_REASONS,
  routeAccess,
} from '@/infrastructure/auth/route-matrix'

/**
 * S01-02：路由矩陣本身的規則（契約 03 §2）。
 *
 * 這支是純邏輯；「安裝版本的實際 route table 與本表逐條一致」是另一個 gate，
 * 在 `auth-routes.integration.test.ts`。
 */

describe('預設拒絕', () => {
  it('沒列在白名單的路徑一律 blocked', () => {
    expect(routeAccess('/admin/list-users', 'GET')).toBe('blocked')
    expect(routeAccess('/admin/ban-user', 'POST')).toBe('blocked')
    expect(routeAccess('/update-user', 'POST')).toBe('blocked')
    expect(routeAccess('/unlink-account', 'POST')).toBe('blocked')
    expect(routeAccess('/request-password-reset', 'POST')).toBe('blocked')
    expect(routeAccess('/這個端點根本不存在', 'POST')).toBe('blocked')
  })

  it('白名單上的路徑放行', () => {
    expect(routeAccess('/sign-in/email', 'POST')).toBe('allowed')
    expect(routeAccess('/sign-up/email', 'POST')).toBe('allowed')
    expect(routeAccess('/sign-out', 'POST')).toBe('allowed')
    expect(routeAccess('/get-session', 'GET')).toBe('allowed')
    expect(routeAccess('/get-session', 'POST')).toBe('allowed')
  })

  it('方法也算在內：白名單路徑用沒列的方法一樣被擋', () => {
    expect(routeAccess('/sign-in/email', 'GET')).toBe('blocked')
    expect(routeAccess('/list-accounts', 'POST')).toBe('blocked')
    expect(routeAccess('/sign-out', 'GET')).toBe('blocked')
    expect(routeAccess('/sign-in/email', 'DELETE')).toBe('blocked')
  })

  it('大小寫不同的方法也認得', () => {
    expect(routeAccess('/sign-in/email', 'post')).toBe('allowed')
  })
})

describe('路徑參數', () => {
  it('`/callback/:id` 對到實際的 provider', () => {
    expect(routeAccess('/callback/google', 'GET')).toBe('allowed')
    expect(routeAccess('/callback/google', 'POST')).toBe('allowed')
  })

  it('只吃一段：多一層路徑不算命中', () => {
    expect(routeAccess('/callback/google/extra', 'GET')).toBe('blocked')
    expect(routeAccess('/callback', 'GET')).toBe('blocked')
  })

  it('`/reset-password/:token` 是封鎖路由，帶什麼 token 都一樣', () => {
    expect(routeAccess('/reset-password/anything', 'GET')).toBe('blocked')
  })

  it('路徑裡的正則字元不會被當成萬用字元', () => {
    // `/sign-in/email` 若被當成正則，`/sign-inXemail` 會誤中。
    expect(routeAccess('/sign-inXemail', 'POST')).toBe('blocked')
  })
})

describe('從請求 URL 取端點路徑', () => {
  it('去掉 /api/auth 前綴', () => {
    expect(authPathFromUrl('http://localhost:3000/api/auth/sign-in/email')).toBe('/sign-in/email')
    expect(authPathFromUrl('https://fju.roy422.dev/api/auth/admin/list-users?x=1')).toBe('/admin/list-users')
  })

  it('剛好是前綴本身時回根路徑', () => {
    expect(authPathFromUrl('http://localhost:3000/api/auth')).toBe('/')
  })

  it('尾端多一條斜線不會變成沒命中', () => {
    expect(routeAccess(authPathFromUrl('http://localhost:3000/api/auth/sign-out/'), 'POST')).toBe('allowed')
  })
})

describe('矩陣本身的健康檢查', () => {
  it('白名單與封鎖理由表沒有重疊（同一條路不能又開又擋）', () => {
    const allowed = new Set(ALLOWED_ROUTES.map((r) => r.path))
    for (const path of Object.keys(BLOCKED_ROUTE_REASONS)) {
      expect(allowed.has(path), `${path} 同時出現在白名單與封鎖清單`).toBe(false)
    }
  })

  it('每一條白名單都寫了理由，且只用 GET／POST', () => {
    for (const route of ALLOWED_ROUTES) {
      expect(route.note.length, `${route.path} 沒寫理由`).toBeGreaterThan(0)
      expect(route.methods.length, `${route.path} 沒列方法`).toBeGreaterThan(0)
      for (const method of route.methods) expect(['GET', 'POST']).toContain(method)
    }
  })

  it('每一條封鎖理由都不是空的', () => {
    for (const [path, reason] of Object.entries(BLOCKED_ROUTE_REASONS)) {
      expect(reason.length, `${path} 沒寫封鎖理由`).toBeGreaterThan(0)
    }
  })
})
