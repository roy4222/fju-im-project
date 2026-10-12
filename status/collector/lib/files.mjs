// 讀寫 JSON 的小工具。寫入一律「先寫暫存檔再改名」，status-web 不會讀到寫一半的檔。
import fs from 'node:fs'
import path from 'node:path'
import { findLeaks, findSensitiveKeys } from './redact.mjs'
import { ShapeError, project } from './shape.mjs'
import { shapeFor } from './shapes.mjs'

export class LeakError extends Error {
  constructor(file, kinds) {
    super(`遮蔽檢查命中（${kinds.join('、')}），${file} 不寫、保留上一版`)
    this.kinds = kinds
  }
}

/** 讀 JSON 檔：不存在回 { missing: true }，壞掉回 { error }，正常回 { value }。 */
export function readJson(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true }
    return { error: `讀不到 ${path.basename(file)}（${err.code ?? err.message}）` }
  }
  try {
    return { value: JSON.parse(text) }
  } catch {
    return { error: `${path.basename(file)} 不是合法的 JSON` }
  }
}

/**
 * 兩道把關再序列化：
 *  1. 白名單投影（lib/shapes.mjs）：只複製規格列的欄位，值要合型別與樣式；不合就丟 LeakError（只帶路徑與原因）。
 *  2. 黑名單掃描投影後的文字（findLeaks）與鍵名（findSensitiveKeys）。
 * 任一道命中就丟 LeakError，什麼都不寫。錯誤只說類別與欄位路徑，不帶值。
 */
export function serializeChecked(name, value) {
  let projected
  try {
    projected = project(shapeFor(name), value)
  } catch (err) {
    if (!(err instanceof ShapeError)) throw err
    throw new LeakError(name, [`欄位格式不符（${err.message}）`, ...err.leakKinds])
  }
  const text = JSON.stringify(projected, null, 2) + '\n'
  const leaks = findLeaks(text)
  if (findSensitiveKeys(projected).length > 0) leaks.push('敏感欄位')
  if (leaks.length > 0) throw new LeakError(name, leaks)
  return text
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o644 })
  fs.renameSync(tmp, file)
}

export function writeJsonChecked(dataDir, rel, value) {
  writeText(path.join(dataDir, rel), serializeChecked(rel, value))
}
