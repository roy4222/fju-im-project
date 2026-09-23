/**
 * 登入後要回去的 `next`：只接受站內相對路徑，其餘一律回 `null`（呼叫端退回預設首頁）。
 *
 * 不能只看「開頭是 `/`、不是 `//`」：WHATWG URL 解析對 http(s) 把 `\` 當 `/`，
 * 所以 `/\evil.com`、`/\/evil.com` 會通過前綴檢查卻被瀏覽器解析成 `https://evil.com/`
 * （PR #210 合併 review）。這裡的規則：
 *
 * 1. 不可含控制字元——`new URL()` 會默默刪掉 `\t`、`\n`、`\r` 再解析，
 *    讓 `/\t/evil.com` 之類的變形在檢查時跟實際導向時長得不一樣。
 * 2. 必須以單一 `/` 開頭，第二個字元不可以是 `/` 或 `\`。
 * 3. 以固定的假 origin 解析後，origin 必須不變。
 * 4. 原字串**解碼一次後**也要通過 1–3：query 裡的 `%5C`、`%2F`、`%0A`
 *    不管在哪一層被解碼，都不能變成站外位址。
 *
 * 回傳的是解析後的 `pathname + search`（正規化過），不是原字串。
 */
const BASE = 'http://next.invalid'

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

function passes(candidate: string): URL | null {
  if (CONTROL_CHARS.test(candidate)) return null
  if (candidate[0] !== '/') return null
  if (candidate[1] === '/' || candidate[1] === '\\') return null
  let url: URL
  try {
    url = new URL(candidate, BASE)
  } catch {
    return null
  }
  return url.origin === BASE ? url : null
}

export function safeNextPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null

  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!passes(decoded)) return null

  const url = passes(raw)
  return url ? `${url.pathname}${url.search}` : null
}
