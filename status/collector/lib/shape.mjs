// 白名單投影（任務單：輸出 JSON 一律由白名單欄位組成，黑名單只當第二道）。
// shape 是函式 (value, path) => 投影後的值：只複製列出的欄位、值要符合型別與樣式；不合就丟 ShapeError。
// ShapeError 的訊息只帶「路徑：原因」，不帶值（路徑一律是這裡列出的固定鍵名或陣列索引）。
import { findLeaks } from './redact.mjs'

export class ShapeError extends Error {
  constructor(path, why, leakKinds = []) {
    super(`${path || '（根）'}：${why}`)
    this.path = path
    this.why = why
    /** 值不合樣式時順便用黑名單判類別（例如 'token'），給錯誤訊息用；一樣不帶值。 */
    this.leakKinds = leakKinds
  }
}

const sub = (at, k) => (at ? `${at}.${k}` : k)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export const T = {
  /** 字串：re 是允許的樣式（null＝自由文字，例如錯誤訊息），max 是長度上限。 */
  str:
    (re, max = 1000) =>
    (v, at) => {
      if (typeof v !== 'string') throw new ShapeError(at, '要是字串')
      if (v.length > max) throw new ShapeError(at, `超過 ${max} 字`, findLeaks(v))
      if (re && !re.test(v)) throw new ShapeError(at, '格式不符', findLeaks(v))
      return v
    },
  int: () => (v, at) => {
    if (!Number.isInteger(v)) throw new ShapeError(at, '要是整數')
    return v
  },
  bool: () => (v, at) => {
    if (typeof v !== 'boolean') throw new ShapeError(at, '要是布林')
    return v
  },
  nullable: (s) => (v, at) => (v === null ? null : s(v, at)),
  /** 欄位可以沒有（沒有就不輸出）；有的話照 s 投影。 */
  optional: (s) => Object.assign((v, at) => s(v, at), { optional: true }),
  oneOf: (list) => (v, at) => {
    if (!list.includes(v)) throw new ShapeError(at, '格式不符', typeof v === 'string' ? findLeaks(v) : [])
    return v
  },
  arr:
    (s, max = 1000) =>
    (v, at) => {
      if (!Array.isArray(v)) throw new ShapeError(at, '要是陣列')
      if (v.length > max) throw new ShapeError(at, `超過 ${max} 筆`)
      return v.map((x, i) => s(x, `${at}[${i}]`))
    },
  /** 物件：只複製 fields 列出的鍵，其他一律丟掉；沒標 optional 的鍵缺了就錯。 */
  obj: (fields) => (v, at) => {
    if (!isPlainObject(v)) throw new ShapeError(at, '要是物件')
    const out = {}
    for (const [k, s] of Object.entries(fields)) {
      const has = Object.hasOwn(v, k) && v[k] !== undefined
      if (!has) {
        if (s.optional) continue
        throw new ShapeError(sub(at, k), '缺欄位')
      }
      out[k] = s(v[k], sub(at, k))
    }
    return out
  },
  /** 鍵名不固定的物件（collector.json 的 sources）：鍵要符合 keyRe，值照 s 投影。 */
  record: (keyRe, s) => (v, at) => {
    if (!isPlainObject(v)) throw new ShapeError(at, '要是物件')
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (!keyRe.test(k)) throw new ShapeError(at, '鍵名格式不符')
      out[k] = s(x, sub(at, k))
    }
    return out
  },
  /**
   * 原樣複本：只給 repo/ 四檔用（設計方案 §3.3「原樣複本＋sourceSha」；docs/status/ 是公開 repo 裡人維護的檔，
   * 形狀歸 S-2 的 check.mjs 管，這裡不重複定義）。stamps 列出要檢查的欄位；其餘只限 JSON 值、限制深度，
   * 內容交給第二道黑名單（findLeaks＋findSensitiveKeys）。
   */
  passthrough:
    (stamps, { maxDepth = 32 } = {}) =>
    (v, at) => {
      if (!isPlainObject(v)) throw new ShapeError(at, '要是物件')
      const out = copyJson(v, at, maxDepth)
      for (const [k, s] of Object.entries(stamps)) {
        if (!Object.hasOwn(v, k) || v[k] === undefined) throw new ShapeError(sub(at, k), '缺欄位')
        out[k] = s(v[k], sub(at, k))
      }
      return out
    },
}

function copyJson(v, at, depth) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ShapeError(at, '不是有限數字')
    return v
  }
  if (depth <= 0) throw new ShapeError(at, '巢狀太深')
  if (Array.isArray(v)) return v.map((x, i) => copyJson(x, `${at}[${i}]`, depth - 1))
  if (isPlainObject(v)) {
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue
      out[k] = copyJson(x, sub(at, k), depth - 1)
    }
    return out
  }
  throw new ShapeError(at, '不是 JSON 值')
}

/** 把 value 投影成只含白名單欄位的新物件；不合就丟 ShapeError。 */
export function project(shape, value) {
  return shape(value, '')
}
