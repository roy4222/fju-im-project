// 讀寫 JSON 的小工具。寫入一律「先寫暫存檔再改名」，status-web 不會讀到寫一半的檔。
import fs from 'node:fs'
import path from 'node:path'
import { findLeaks, findLeaksInValue, findSensitiveKeys } from './redact.mjs'
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
  // 整份文字掃一次，再逐一檢查每個字串值（字串裡的 JSON 會解析出來連鍵名一起查）。
  const leaks = new Set([...findLeaks(text), ...findLeaksInValue(projected)])
  if (findSensitiveKeys(projected).length > 0) leaks.add('敏感欄位')
  if (leaks.size > 0) throw new LeakError(name, [...leaks])
  return text
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o644 })
  fs.renameSync(tmp, file)
}

const VERSION_KEEP = 2
const isVersionName = (n) => /^\d{8}T\d{6}/.test(n)

/**
 * 一批檔案當成一個完整版本發布（repo/ 四檔）：
 *  1. 全部寫進 <dataDir>/<name>-versions/<版本>.tmp-<pid>/，寫齊才把目錄改名成 <版本>/（之後內容不再改）。
 *  2. 做一個相對 symlink <name>.tmp-<pid> → <name>-versions/<版本>，再 rename 成 <name>：單一原子切換，
 *     讀取端照舊讀 <name>/<檔>，任何時刻看到的都是同一版的四檔。
 *  3. 只留最新與前一版（讀到一半的讀取端還能把前一版讀完），更早的與殘留的 .tmp- 清掉。
 * 任一步失敗：暫存目錄、暫存 symlink、剛做好的版本目錄都清掉，指標不動，四檔仍是上一版。
 * 舊版 collector 留下的 <name>/ 真目錄：先搬到 <name>-versions/legacy-<時間>/ 再換上 symlink（只會發生一次）。
 * 讀取端要「同一批固定讀同一版本」：先 realpath(<name>) 一次，再讀解析出來的目錄底下的檔。
 */
export function publishVersion(dataDir, name, version, files) {
  const versionsDir = path.join(dataDir, `${name}-versions`)
  const finalDir = path.join(versionsDir, version)
  const tmpDir = `${finalDir}.tmp-${process.pid}`
  const link = path.join(dataDir, name)
  const tmpLink = `${link}.tmp-${process.pid}`

  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    for (const [file, text] of files) fs.writeFileSync(path.join(tmpDir, file), text, { mode: 0o644 })
    fs.renameSync(tmpDir, finalDir)
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    throw err
  }
  try {
    moveLegacyDir(link, versionsDir)
    fs.rmSync(tmpLink, { force: true })
    fs.symlinkSync(path.posix.join(`${name}-versions`, version), tmpLink)
    fs.renameSync(tmpLink, link)
  } catch (err) {
    fs.rmSync(tmpLink, { force: true })
    fs.rmSync(finalDir, { recursive: true, force: true })
    throw err
  }
  pruneVersions(versionsDir)
}

function moveLegacyDir(link, versionsDir) {
  let st
  try {
    st = fs.lstatSync(link)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (st.isDirectory()) fs.renameSync(link, path.join(versionsDir, `legacy-${Date.now()}`))
}

function pruneVersions(versionsDir) {
  const names = fs.readdirSync(versionsDir)
  const keep = new Set(names.filter((n) => isVersionName(n) && !n.includes('.tmp-')).sort().slice(-VERSION_KEEP))
  for (const n of names) {
    if (keep.has(n)) continue
    try {
      fs.rmSync(path.join(versionsDir, n), { recursive: true, force: true })
    } catch {
      // 清不掉就下一輪再清
    }
  }
}

export function writeJsonChecked(dataDir, rel, value) {
  writeText(path.join(dataDir, rel), serializeChecked(rel, value))
}
