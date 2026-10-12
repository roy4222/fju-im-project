// 第二道把關：寫檔前對「投影後」的資料做黑名單掃描（設計方案 §3.3「一律不寫」）。第一道是 lib/shape.mjs
// 的白名單投影（不在清單的欄位根本不會進輸出）。規則照 e2e/acceptance/summarize-night.sh 的 EMAIL／TOKENS／PW／PW_OK，
// 另加 IPv4／IPv6、連線字串（userinfo 密碼與 query 參數）、Bearer／Basic。
// 每段文字先 NFKC 正規化（全形變半形），再反覆做百分號解碼（最多 MAX_DECODE_ROUNDS 層）逐層掃；字串值本身是 JSON 的話解析出來再查鍵名與值
// （最多 MAX_EMBED_DEPTH 層）；超過上限不猜，直接當命中。
// collector 不改寫內容：命中任何一條就整檔不寫，只回報「哪一類」，不回報命中的字串本身。

// 左邊加「前一個字不是帳號字元」：一長串字母只會從開頭試一次，不會每個位置都重掃到底（70 KB 的字串從數秒變毫秒）。
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/
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
// 像秘密的鍵名／參數名：物件鍵名（findSensitiveKeys）與自由文字的「鍵: 值」（PW）共用同一份清單。
const KEY_WORDS = [
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'token',
  'secret(?:[-_]?key)?',
  'api[-_]?key',
  'access[-_]?key',
  'client[-_]?secret',
  'private[-_]?key',
  'credential',
  'authorization',
  'cookie',
]
// 字尾 pass／passwd／pwd／pw 要獨立成字（db_pass 算、bypass 不算）。
const SENSITIVE_NAME = new RegExp(`(?:^|[^a-z])(?:pass|passwd|pwd|pw)$|${KEY_WORDS.join('|')}|^auth$|sslkey`, 'i')
// query 參數多幾個常見名字（?key=、?sig=、?code=…）；JSON 鍵名不用這組（test-map.json 的 key 是正常欄位）。
const SENSITIVE_PARAM = /^(?:key|auth|sig|signature|session|sessionid|jwt|bearer|otp|code)$/i
// 自由文字裡的「鍵: 值」：鍵名後可接引號（含 JSON 跳脫的 \"），值只要非空、不含引號與反斜線、不是佔位字樣就算
// （Review 第四輪：敏感鍵後的值不受 6 字門檻）。字串裡的 {"password":"…"}、序列化後的 {\"password\":\"…\"}、password='…' 都抓得到。
const PW = new RegExp(
  `((?:密碼|${KEY_WORDS.join('|')})(?:\\\\?["'])?\\s*[:：=]\\s*(?:\\\\?["'])?)([^\\s"'\\\\\`|，。、）)]+)`,
  'gi',
)
// 佔位字樣：環境變數、已遮蔽、沒有／無／N/A／null／none、星號、布林（"hasToken": true 不是秘密）。
const PW_OK = /^(?:\$\{?[A-Z_]+\}?|\[已遮蔽\]|已遮蔽|沒有|無|不記錄.*|由.*|\*+|-+|—|N\/A|null|none|undefined|true|false|\.{3}|…)$/i
// HTTP 標頭：Authorization／Cookie／Set-Cookie／X-Api-Key… 後面整個值都算秘密，連佔位字樣也不放過。
const HEADER = /\b(?:proxy-authorization|authorization|set-cookie|cookie|x-api-key|x-auth-token|x-access-token|api-key)(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?[^\s"'\\]/i
// 任何 scheme://… 都抓出來解析（postgres、postgresql、mysql、redis、mongodb+srv、https…）。
const URI = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]+/g
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/
// IPv6：完整寫法（7 個冒號）或含 `::` 的縮寫。時間 10:00:00 只有兩個冒號、沒有 `::`，不會誤判。
const H = '[0-9A-Fa-f]{1,4}'
const IPV6 = new RegExp(
  `(?<![\\w:])(?:(?:${H}:){7}${H}|(?:${H}:){1,6}:(?:${H}(?::${H}){0,5})?|::(?:${H}(?::${H}){0,6}))(?![\\w:])`,
)
// 連線錯誤訊息裡常帶對方 IP（例如 connect ECONNREFUSED 1.2.3.4:443），寫進 reason 前先換掉。
const IPV4_ALL = new RegExp(IPV4.source, 'g')
const IPV6_ALL = new RegExp(IPV6.source, 'g')

/** 百分號解碼最多解幾層；還能再解就當命中（'編碼層數過多'）。 */
export const MAX_DECODE_ROUNDS = 4
/** 字串裡的 JSON 最多往下解析幾層；再深就當命中（'編碼層數過多'）。 */
export const MAX_EMBED_DEPTH = 4
/** 字串裡的 JSON 超過這個長度不解析，直接當命中（'內嵌資料過大'）。 */
export const MAX_EMBED_BYTES = 65536

/** 只解 %XX（不合法的 % 原樣留著；多位元組字元解成單位元組字元沒關係，只是用來比對）。 */
export function percentDecode(text) {
  return text.replace(/%[0-9A-Fa-f]{2}/g, (h) => String.fromCharCode(parseInt(h.slice(1), 16)))
}

/**
 * 鍵名與文字共用的「正規化＋有界逐層解碼」：先 NFKC（全形字母、全形％＝：＠／都變半形），再逐層百分號解碼、每層再 NFKC，
 * 最多 MAX_DECODE_ROUNDS 層。回傳每一層的文字（都要掃）與是否超限（超限＝不猜了，直接當命中）。
 */
export function decodeRounds(text) {
  const rounds = []
  let t = String(text).normalize('NFKC')
  for (let round = 0; ; round++) {
    rounds.push(t)
    const next = percentDecode(t).normalize('NFKC')
    if (next === t) return { rounds, overflow: false }
    if (round >= MAX_DECODE_ROUNDS) return { rounds, overflow: true }
    t = next
  }
}

/** 鍵名像秘密（物件鍵名與 query 參數共用）：每一層解碼後的寫法都看；解到上限還能再解就當敏感。 */
export function isSensitiveName(name) {
  const { rounds, overflow } = decodeRounds(name)
  return overflow || rounds.some((r) => SENSITIVE_NAME.test(r))
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

function scanText(t, hits) {
  if (EMAIL.test(t)) hits.add('Email')
  if (TOKENS.some((p) => p.test(t))) hits.add('token')
  if (hasUriCredentials(t)) hits.add('連線字串')
  for (const m of t.matchAll(PW)) {
    if (!PW_OK.test(m[2])) {
      hits.add('密碼')
      break
    }
  }
  if (HEADER.test(t)) hits.add('密碼')
  if (IPV4.test(t) || IPV6.test(t)) hits.add('IP')
}

/**
 * 回傳命中的類別（'Email'、'token'、'連線字串'、'密碼'、'IP'、'編碼層數過多'），沒命中回傳空陣列。
 * 原文先掃一次，再逐層百分號解碼各掃一次（最多 MAX_DECODE_ROUNDS 層）；解到上限還能再解就當命中。
 */
export function findLeaks(text) {
  const hits = new Set()
  const { rounds, overflow } = decodeRounds(text)
  for (const t of rounds) scanText(t, hits)
  if (overflow) hits.add('編碼層數過多')
  return [...hits]
}

/** 字串值本身是 JSON（或百分號解碼後是 JSON）：解析出來，連鍵名一起查；疊太多層或太大就當命中。 */
function embeddedJsonLeaks(text, depth) {
  for (const t of decodeRounds(text).rounds) {
    const s = t.trim()
    if (s.startsWith('{') || s.startsWith('[')) {
      if (s.length > MAX_EMBED_BYTES) return ['內嵌資料過大']
      let parsed = null
      try {
        parsed = JSON.parse(s)
      } catch {
        parsed = null
      }
      if (parsed && typeof parsed === 'object') {
        if (depth >= MAX_EMBED_DEPTH) return ['編碼層數過多']
        const kinds = findLeaksInValue(parsed, depth + 1)
        if (findSensitiveKeys(parsed).length > 0) kinds.push('敏感欄位')
        return kinds
      }
    }
  }
  return []
}

/**
 * 逐一檢查物件裡的每個字串值：findLeaks（含逐層解碼）＋內嵌 JSON 解析後遞迴。
 * 跟整份序列化文字的 findLeaks 不同處：字串裡的 JSON 會被真的解析，token:["…"] 這種包在字串裡的容器也抓得到。
 */
export function findLeaksInValue(value, depth = 0) {
  const hits = new Set()
  const walk = (v) => {
    if (typeof v === 'string') {
      // 太長的字串不掃（白名單的文字欄位都有長度上限；repo 原樣複本裡出現這麼長的字串不正常）：直接當命中。
      if (v.length > MAX_EMBED_BYTES) {
        hits.add('內嵌資料過大')
        return
      }
      for (const k of findLeaks(v)) hits.add(k)
      for (const k of embeddedJsonLeaks(v, depth)) hits.add(k)
    } else if (Array.isArray(v)) {
      v.forEach(walk)
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk)
    }
  }
  walk(value)
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
