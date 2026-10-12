// 寫檔前的遮蔽檢查（設計方案 §3.3「一律不寫」）。規則照 e2e/acceptance/summarize-night.sh 的
// EMAIL／TOKENS／PW／PW_OK，另加 IPv4（VM IP 也不能出現在畫面上）。
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
const PW = /((?:密碼|password|passwd|pwd|token|secret)\s*[:：=]\s*)([^\s`|，。、）)]{6,})/gi
const PW_OK = /^(?:\$\{?[A-Z_]+\}?|\[已遮蔽\]|已遮蔽|沒有|不記錄.*|由.*|\*+)$/
const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/
// 連線錯誤訊息裡常帶對方 IP（例如 connect ECONNREFUSED 1.2.3.4:443），寫進 reason 前先換掉。
const IPV4_ALL = new RegExp(IPV4.source, 'g')

/** 回傳命中的類別（'Email'、'token'、'密碼'、'IP'），沒命中回傳空陣列。 */
export function findLeaks(text) {
  const hits = []
  if (EMAIL.test(text)) hits.push('Email')
  if (TOKENS.some((p) => p.test(text))) hits.push('token')
  for (const m of text.matchAll(PW)) {
    if (!PW_OK.test(m[2])) {
      hits.push('密碼')
      break
    }
  }
  if (IPV4.test(text)) hits.push('IP')
  return hits
}

/** 自由文字（錯誤訊息）寫進 JSON 前用：IP 換成 [IP]，其餘交給 findLeaks 整檔把關。 */
export function scrubIp(text) {
  return String(text).replace(IPV4_ALL, '[IP]')
}
