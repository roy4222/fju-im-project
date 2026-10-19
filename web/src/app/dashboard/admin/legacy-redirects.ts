/**
 * 系辦後台的舊網址要轉去哪（C 階段規格② 設計方案 §8）：書籤與通知連結不能 404。
 *
 * - `paths`：整頁拿掉的舊路由 → 新路由。
 * - `queries`：同一條路由、舊的篩選參數改成分頁 → 對應分頁（這個參數拿掉，其餘 query 照帶）。
 *
 * 轉址跟目標頁的內容同一票交付：`?status=`（帳號）在 C2-07、`/home-settings` 在 C2-17（已加）、`?placement=honor` 在①（C1-09，已加）、
 * `/signoff` 在 C2-22 才加進來。頁面要先 `requireRole` 再轉（沒登入到登入頁、角色不對到 `/403`，不會先被轉走）。
 */
export const ADMIN_LEGACY_REDIRECTS = {
  paths: {
    '/dashboard/admin/settings': '/dashboard/admin/cohorts',
    // 首頁設定（C2-17）：大圖與標語改在前台直接編輯（編輯模式的「首頁橫幅」），舊網址回前台首頁。
    '/dashboard/admin/home-settings': '/',
  },
  queries: {
    '/dashboard/admin/accounts': {
      key: 'status',
      to: {
        pending: '/dashboard/admin/accounts/pending',
        disabled: '/dashboard/admin/accounts/disabled',
      },
    },
    '/dashboard/admin/affairs': {
      key: 'placement',
      to: {
        resource: '/dashboard/admin/affairs/resources',
        submission: '/dashboard/admin/affairs/assignments',
        requirement: '/dashboard/admin/affairs/assignments',
        rules: '/dashboard/admin/affairs/rules',
        // ①（C1-09）：「榮譽」篩選搬到成果展示分頁的榮譽榜區。
        honor: '/dashboard/admin/showcase',
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

/** 只認自己的鍵：網址來的字串可能是 `toString`、`constructor`、`__proto__`，不能拿到繼承的屬性。 */
function own<T>(table: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined
}

/** 舊網址（路徑＋query）→ 新網址；不是舊網址回 `null`（照常顯示這一頁）。 */
export function legacyAdminRedirect(path: string, params: SearchParams = {}): string | null {
  const target = own<string>(ADMIN_LEGACY_REDIRECTS.paths, path)
  if (target) return withQuery(target, params)

  const rule = own<{ key: string; to: Readonly<Record<string, string>> }>(ADMIN_LEGACY_REDIRECTS.queries, path)
  if (!rule) return null
  const raw = params[rule.key]
  const to = own(rule.to, Array.isArray(raw) ? raw[0] : raw)
  return to ? withQuery(to, params, rule.key) : null
}
