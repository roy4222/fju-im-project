/**
 * Route Handler 的 POST 要檢查請求是不是從本站發出的（契約 03 §6：Server Action 由 Next 內建
 * Origin 檢查；Route Handler 要自己看 `Origin`／`Sec-Fetch-Site`）。
 *
 * cookie 是 `sameSite=lax`，跨站的 POST 本來就不會帶 session；這一層是第二道，
 * 也順便擋掉「用 curl 拿著偷來的 cookie 直接打」這種沒有瀏覽器標頭的請求。
 *
 * 規則：
 * 1. 有 `Sec-Fetch-Site`（現代瀏覽器都會帶）就只接受 `same-origin`。
 * 2. 否則看 `Origin`：主機要等於這次請求的 `Host`，或等於設定的站台網址（例如 `BETTER_AUTH_URL`）。
 * 3. 兩個都沒有：拒絕。
 */
export function isSameOriginRequest(headers: Headers, allowedOrigins: readonly string[] = []): boolean {
  const fetchSite = headers.get('sec-fetch-site')
  if (fetchSite) return fetchSite === 'same-origin'

  const origin = headers.get('origin')
  if (!origin || origin === 'null') return false

  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }

  const host = headers.get('host')
  if (host && originUrl.host === host) return true

  return allowedOrigins.some((allowed) => {
    try {
      return new URL(allowed).origin === originUrl.origin
    } catch {
      return false
    }
  })
}
