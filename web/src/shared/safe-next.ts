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
 * 5. 回傳的是解析後的 `pathname + search`（正規化過），而這個**回傳值本身**也要
 *    通過 1–4、且再正規化一次不變。WHATWG 會折掉 `.`／`..` 段、把 `\` 換成 `/`，
 *    所以 `/.//evil.com`、`/dashboard/..//evil.com`、`/a\..\\evil.com`、`/%2e//evil.com`
 *    原字串過得了 2，正規化後卻是 protocol-relative 的 `//evil.com`
 *    （PR #210 第 2 次合併 review）。檢查的是最後寫進 `Location` 的那個字串。
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

function normalize(raw: unknown): string | null {
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

export function safeNextPath(raw: unknown): string | null {
  const out = normalize(raw)
  if (out === null) return null
  return normalize(out) === out ? out : null
}
