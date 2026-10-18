/**
 * 系辦後台的舊網址要轉去哪（C 階段規格② 設計方案 §8）：書籤與通知連結不能 404。
 *
 * - `paths`：整頁拿掉的舊路由 → 新路由。
 * - `queries`：同一條路由、舊的篩選參數改成分頁 → 對應分頁（這個參數拿掉，其餘 query 照帶）。
 *
 * 轉址跟目標頁的內容同一票交付：`?status=`（帳號）在 C2-07、`/home-settings` 在 C2-17、`?placement=honor` 在①、
 * `/signoff` 在 C2-22 才加進來。頁面要先 `requireRole` 再轉（沒登入到登入頁、角色不對到 `/403`，不會先被轉走）。
 */
export const ADMIN_LEGACY_REDIRECTS = {
  paths: {
    '/dashboard/admin/settings': '/dashboard/admin/cohorts',
  },
  queries: {
    '/dashboard/admin/affairs': {
      key: 'placement',
      to: {
        resource: '/dashboard/admin/affairs/resources',
        submission: '/dashboard/admin/affairs/assignments',
        requirement: '/dashboard/admin/affairs/assignments',
        rules: '/dashboard/admin/affairs/rules',
      },
    },
  },
} as const satisfies {
  paths: Record<string, string>
  queries: Record<string, { key: string; to: Record<string, string> }>
}

export type SearchParams = Readonly<Record<string, string | string[] | undefined>>

function withQuery(target: string, params: SearchParams, drop?: string): string {
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (key === drop || value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) next.append(key, v)
  }
  const query = next.toString()
  return query ? `${target}?${query}` : target
}

/** 舊網址（路徑＋query）→ 新網址；不是舊網址回 `null`（照常顯示這一頁）。 */
export function legacyAdminRedirect(path: string, params: SearchParams = {}): string | null {
  const paths: Readonly<Record<string, string>> = ADMIN_LEGACY_REDIRECTS.paths
  const target = paths[path]
  if (target) return withQuery(target, params)

  const queries: Readonly<Record<string, { key: string; to: Readonly<Record<string, string>> }>> = ADMIN_LEGACY_REDIRECTS.queries
  const rule = queries[path]
  if (!rule) return null
  const raw = params[rule.key]
  const value = Array.isArray(raw) ? raw[0] : raw
  const to = value === undefined ? undefined : rule.to[value]
  return to ? withQuery(to, params, rule.key) : null
}
