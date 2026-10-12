// 第二道把關：寫檔前對「投影後」的 JSON 文字做黑名單掃描（設計方案 §3.3「一律不寫」）。第一道是 lib/shape.mjs
// 的白名單投影（不在清單的欄位根本不會進輸出）。規則照 e2e/acceptance/summarize-night.sh 的 EMAIL／TOKENS／PW／PW_OK，
// 另加 IPv4／IPv6、連線字串（userinfo 密碼與 query 參數）、Bearer／Basic；每段文字掃「原文」與「百分號解碼後」各一次。
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
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\bBasic\s+[A-Za-z0-9+/=]{16,}/,
]
// 自由文字裡的「鍵: 值」：鍵名像秘密、值 6 字以上且不是佔位字樣。
const PW =
  /((?:密碼|password|passwd|passphrase|pwd|token|secret(?:[-_]?key)?|api[-_]?key|access[-_]?key|client[-_]?secret|private[-_]?key|authorization|cookie)\s*[:：=]\s*)([^\s`|，。、）)]{6,})/gi
const PW_OK = /^(?:\$\{?[A-Z_]+\}?|\[已遮蔽\]|已遮蔽|沒有|不記錄.*|由.*|\*+)$/
// 任何 scheme://… 都抓出來解析（postgres、postgresql、mysql、redis、mongodb+srv、https…）。
const URI = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+/g
// 物件鍵名或 query 參數名像秘密。字尾 pass／passwd／pwd／pw 要獨立成字（db_pass 算、bypass 不算）。
const SENSITIVE_NAME =
  /(?:^|[^a-z])(?:pass|passwd|pwd|pw)$|password|passphrase|secret|token|api[-_]?key|private[-_]?key|credential|authorization|cookie|^auth$|sslkey/i
// query 參數多幾個常見名字（?key=、?sig=、?code=…）；JSON 鍵名不用這組（test-map.json 的 key 是正常欄位）。
const SENSITIVE_PARAM = /^(?:key|auth|sig|signature|session|sessionid|jwt|bearer|otp|code)$/i
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/
// IPv6：完整寫法（7 個冒號）或含 `::` 的縮寫。時間 10:00:00 只有兩個冒號、沒有 `::`，不會誤判。
const H = '[0-9A-Fa-f]{1,4}'
const IPV6 = new RegExp(
  `(?<![\\w:])(?:(?:${H}:){7}${H}|(?:${H}:){1,6}:(?:${H}(?::${H}){0,5})?|::(?:${H}(?::${H}){0,6}))(?![\\w:])`,
)
// 連線錯誤訊息裡常帶對方 IP（例如 connect ECONNREFUSED 1.2.3.4:443），寫進 reason 前先換掉。
const IPV4_ALL = new RegExp(IPV4.source, 'g')
const IPV6_ALL = new RegExp(IPV6.source, 'g')

/** 只解 %XX（不合法的 % 原樣留著；多位元組字元解成單位元組字元沒關係，只是用來比對）。 */
export function percentDecode(text) {
  return text.replace(/%[0-9A-Fa-f]{2}/g, (h) => String.fromCharCode(parseInt(h.slice(1), 16)))
}

/** 鍵名像秘密（物件鍵名與 query 參數共用；鍵名先做百分號解碼）。 */
export function isSensitiveName(name) {
  return SENSITIVE_NAME.test(percentDecode(String(name)))
}

/**
 * 連線字串：抓出每個 scheme://… 自己解析（不靠 URL 類別，壞掉的字串也要能判）。
 *  - userinfo 有「冒號後非空」就算（user:pw@、:pw@；冒號被編碼成 %3A 也算）。
 *  - query 參數名像秘密（password、passwd、token、api_key、key、sig…；名字 URL 編碼也算）且值非空就算，1 個字元也算。
 */
function hasUriCredentials(text) {
  for (const m of text.matchAll(URI)) {
    const rest = m[0].slice(m[0].indexOf('://') + 3)
    const authority = rest.split(/[/?#]/, 1)[0]
    const at = authority.lastIndexOf('@')
    if (at !== -1) {
      const userinfo = percentDecode(authority.slice(0, at))
      const colon = userinfo.indexOf(':')
      if (colon !== -1 && colon < userinfo.length - 1) return true
    }
    const q = rest.indexOf('?')
    if (q === -1) continue
    const query = rest.slice(q + 1).split('#', 1)[0]
    for (const pair of query.split('&')) {
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const key = percentDecode(pair.slice(0, eq)).trim()
      if (pair.length > eq + 1 && (isSensitiveName(key) || SENSITIVE_PARAM.test(key))) return true
    }
  }
  return false
}

/** 回傳命中的類別（'Email'、'token'、'連線字串'、'密碼'、'IP'），沒命中回傳空陣列。 */
export function findLeaks(text) {
  const hits = new Set()
  const raw = String(text)
  const decoded = percentDecode(raw)
  for (const t of decoded === raw ? [raw] : [raw, decoded]) {
    if (EMAIL.test(t)) hits.add('Email')
    if (TOKENS.some((p) => p.test(t))) hits.add('token')
    if (hasUriCredentials(t)) hits.add('連線字串')
    for (const m of t.matchAll(PW)) {
      if (!PW_OK.test(m[2])) {
        hits.add('密碼')
        break
      }
    }
    if (IPV4.test(t) || IPV6.test(t)) hits.add('IP')
  }
  return [...hits]
}

/** 值（含底下任何一層）有實值：非空且不是佔位字樣的字串，或數字。布林、null、空容器不算。 */
function hasValue(v) {
  if (typeof v === 'string') return v !== '' && !PW_OK.test(v)
  if (typeof v === 'number') return true
  if (Array.isArray(v)) return v.some(hasValue)
  if (v && typeof v === 'object') return Object.values(v).some(hasValue)
  return false
}

/**
 * 走過整個物件：鍵名像秘密、而且值（不管包在幾層陣列／物件裡）有實值就算命中，回傳命中的鍵名路徑。
 * 命中就停在那個鍵（token:["x"]、secret:{value:"x"} 都回 token／secret），不再往下走。
 */
export function findSensitiveKeys(value, at = '') {
  const hits = []
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findSensitiveKeys(v, `${at}[${i}]`)))
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const where = at ? `${at}.${k}` : k
      if (isSensitiveName(k)) {
        if (hasValue(v)) hits.push(where)
      } else {
        hits.push(...findSensitiveKeys(v, where))
      }
    }
  }
  return hits
}

/** 自由文字（錯誤訊息）寫進 JSON 前用：IP 換成 [IP]，其餘交給 findLeaks 整檔把關。 */
export function scrubIp(text) {
  return String(text).replace(IPV4_ALL, '[IP]').replace(IPV6_ALL, '[IP]')
}
