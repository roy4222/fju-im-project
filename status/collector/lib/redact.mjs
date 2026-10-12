// 寫檔前的遮蔽檢查（設計方案 §3.3「一律不寫」）。規則照 e2e/acceptance/summarize-night.sh 的
// EMAIL／TOKENS／PW／PW_OK，另加 IPv4／IPv6（VM IP 也不能出現在畫面上）。
// collector 不改寫內容：命中任何一條就整檔不寫，只回報「哪一類」，不回報命中的字串本身。

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/
const TOKENS = [
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bdp\.(?:st|pt|ct|sa|scim)\.[A-Za-z0-9_.-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]
// 帶帳密的連線字串：scheme://帳號:密碼@主機（postgres://、redis://、https://… 都算）。
const URI_CREDENTIALS = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@"'<>]*:[^\s/@"'<>]+@/
// 物件的鍵名像秘密（JSON 的 "password": "…" 中間隔著引號，上面的 PW 抓不到，所以另外看鍵）。
const SENSITIVE_KEY = /(?:^|[-_])(?:pass|passwd|pwd)$|password|secret|token|api[-_]?key|private[-_]?key|credential|authorization|cookie/i
const PW = /((?:密碼|password|passwd|pwd|token|secret)\s*[:：=]\s*)([^\s`|，。、）)]{6,})/gi
const PW_OK = /^(?:\$\{?[A-Z_]+\}?|\[已遮蔽\]|已遮蔽|沒有|不記錄.*|由.*|\*+)$/
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/
// IPv6：完整寫法（7 個冒號）或含 `::` 的縮寫。時間 10:00:00 只有兩個冒號、沒有 `::`，不會誤判。
const H = '[0-9A-Fa-f]{1,4}'
const IPV6 = new RegExp(
  `(?<![\\w:])(?:(?:${H}:){7}${H}|(?:${H}:){1,6}:(?:${H}(?::${H}){0,5})?|::(?:${H}(?::${H}){0,6}))(?![\\w:])`,
)
// 連線錯誤訊息裡常帶對方 IP（例如 connect ECONNREFUSED 1.2.3.4:443），寫進 reason 前先換掉。
const IPV4_ALL = new RegExp(IPV4.source, 'g')
const IPV6_ALL = new RegExp(IPV6.source, 'g')

/** 回傳命中的類別（'Email'、'token'、'密碼'、'IP'），沒命中回傳空陣列。 */
export function findLeaks(text) {
  const hits = []
  if (EMAIL.test(text)) hits.push('Email')
  if (TOKENS.some((p) => p.test(text))) hits.push('token')
  if (URI_CREDENTIALS.test(text)) hits.push('連線字串')
  for (const m of text.matchAll(PW)) {
    if (!PW_OK.test(m[2])) {
      hits.push('密碼')
      break
    }
  }
  if (IPV4.test(text) || IPV6.test(text)) hits.push('IP')
  return hits
}

/** 走過整個物件：鍵名像秘密、而且值是非空字串或數字（不是佔位字樣）就算命中，回傳命中的鍵名路徑。 */
export function findSensitiveKeys(value, at = '') {
  const hits = []
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findSensitiveKeys(v, `${at}[${i}]`)))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const where = at ? `${at}.${k}` : k
      const filled = (typeof v === 'string' && v !== '' && !PW_OK.test(v)) || typeof v === 'number'
      if (SENSITIVE_KEY.test(k) && filled) hits.push(where)
      else hits.push(...findSensitiveKeys(v, where))
    }
  }
  return hits
}

/** 自由文字（錯誤訊息）寫進 JSON 前用：IP 換成 [IP]，其餘交給 findLeaks 整檔把關。 */
export function scrubIp(text) {
  return String(text).replace(IPV4_ALL, '[IP]').replace(IPV6_ALL, '[IP]')
}
