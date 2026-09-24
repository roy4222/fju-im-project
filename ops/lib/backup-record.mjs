#!/usr/bin/env node
// 備份與還原演練的紀錄檔（票 27，2026-09-24）。由 ops/backup.sh、ops/restore-drill.sh 呼叫，不單獨用。
//
// 紀錄存在 VM 上 /srv/fju/<站>/backups/records.jsonl：一行一筆 JSON、只往後加、不改舊行，
// 所以「失敗不覆蓋上次成功時間」是自然成立的——最近成功＝最後一筆 status=ok 的那行。
// 檔案第一次建立時就是 600（只有 deploy 讀得到）。資料庫的 backup_runs／restore_drills 表
// 還沒建（資料庫線由票 19 使用中），之後補表時把這個檔匯進去即可。
//
//   node backup-record.mjs append  <records.jsonl> key=value ... （value 以 json: 開頭表示 JSON）
//   node backup-record.mjs lookup  <records.jsonl> <備份檔名>    印出該檔最近一筆成功備份紀錄（沒有就印空）
//   node backup-record.mjs compare <基準 counts JSON 檔> <實際 counts JSON 檔> [另一個可接受的基準]
//   node backup-record.mjs status  <records.jsonl>
//
// 只用 Node 18 內建功能（VM 上是 Ubuntu 的 nodejs）。不讀、不寫任何秘密。
import fs from 'node:fs'

const [, , cmd, ...args] = process.argv

// 首頁要看的幾張表，照這個順序顯示；其他表一樣會比對，只是不特別標名稱。
const KEY_TABLES = [
  ['users', '帳號'],
  ['accounts', '登入方式'],
  ['role_assignments', '角色指派'],
  ['groups', '組別'],
  ['group_memberships', '組員'],
  ['submission_versions', '回答版本'],
]
// 評分、簽核的表還沒建（票 19 之後）；名稱符合就一起列出來，一張都沒有就說「還沒建」。
const SCORE_PATTERN = /(score|grade|evaluat)/i
const APPROVAL_PATTERN = /(approv|signoff|sign_off)/i

function readRecords(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 壞掉的行（例如寫到一半斷電）略過，不讓整份紀錄讀不出來。
    }
  }
  return out
}

function append(file, pairs) {
  const record = {}
  for (const pair of pairs) {
    const i = pair.indexOf('=')
    if (i < 1) throw new Error(`參數要是 key=value：${pair}`)
    const key = pair.slice(0, i)
    const raw = pair.slice(i + 1)
    if (raw.startsWith('json:')) {
      const body = raw.slice(5)
      record[key] = body === '' ? null : JSON.parse(body)
    } else if (raw.startsWith('file:')) {
      const body = fs.readFileSync(raw.slice(5), 'utf8').trim()
      record[key] = body === '' ? null : JSON.parse(body)
    } else {
      record[key] = raw
    }
  }
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 })
}

function lookup(file, name) {
  const hit = readRecords(file)
    .filter((r) => r.kind === 'backup' && r.status === 'ok' && r.file === name)
    .pop()
  if (hit) process.stdout.write(JSON.stringify(hit) + '\n')
}

function readJson(path) {
  const text = fs.readFileSync(path, 'utf8').trim()
  return text ? JSON.parse(text) : null
}

function shortName(qualified) {
  const dot = qualified.lastIndexOf('.')
  return dot >= 0 ? qualified.slice(dot + 1) : qualified
}

// 比對：每張表的筆數、回答版本內容的 md5。基準可以給兩份（備份前後各量一次），
// 某一項跟其中任一份相同就算對得上——備份期間若有人寫入，dump 會落在兩次之間。
function compare(basePaths, actualPath) {
  const bases = basePaths.map(readJson).filter(Boolean)
  const actual = readJson(actualPath)
  const names = new Set()
  for (const b of bases) for (const k of Object.keys(b.tables ?? {})) names.add(k)
  for (const k of Object.keys(actual.tables ?? {})) names.add(k)

  const mismatches = []
  const rows = []
  for (const name of [...names].sort()) {
    const got = actual.tables?.[name]
    const expected = bases.map((b) => b.tables?.[name])
    const ok = expected.some((e) => e === got)
    if (!ok) mismatches.push({ table: name, expected: expected[0] ?? null, got: got ?? null })
    rows.push({ name, short: shortName(name), expected: expected[0], got, ok })
  }
  const md5Expected = bases.map((b) => b.submission_versions_md5 ?? null)
  const md5Got = actual.submission_versions_md5 ?? null
  const md5Ok = md5Expected.some((e) => e === md5Got)
  if (!md5Ok) mismatches.push({ table: 'submission_versions（內容 md5）', expected: md5Expected[0], got: md5Got })

  // 基準是誰：預設「備份當下」；沒有備份紀錄時 restore-drill.sh 改用「來源站現在」。
  const basis = process.env.BASELINE_LABEL || '備份當下'
  const show = (label, row) =>
    `  ${row.ok ? '✓' : '✗'} ${label.padEnd(8, '　')} ${String(row.got ?? '（沒有這張表）').padStart(6)}` +
    (row.ok ? '' : `（${basis} ${row.expected ?? '沒有這張表'}）`)
  const lines = [`抽查（還原後 vs ${basis}）：`]
  for (const [table, label] of KEY_TABLES) {
    const row = rows.find((r) => r.short === table)
    lines.push(row ? show(label, row) : `  - ${label}：這個版本還沒有這張表`)
  }
  lines.push(`  ${md5Ok ? '✓' : '✗'} 回答內容 md5 ${md5Ok ? '相同' : '不同'}`)
  for (const [pattern, label] of [
    [SCORE_PATTERN, '評分'],
    [APPROVAL_PATTERN, '簽核'],
  ]) {
    const hit = rows.filter((r) => pattern.test(r.short))
    if (hit.length === 0) lines.push(`  - ${label}：資料庫還沒有${label}的表（之後建了會自動列入）`)
    for (const row of hit) lines.push(show(`${label}:${row.short}`, row))
  }
  const others = rows.filter((r) => !r.ok && !KEY_TABLES.some(([t]) => t === r.short))
  for (const row of others) lines.push(show(row.short, row))
  lines.push(
    mismatches.length === 0
      ? `  全部 ${rows.length} 張表的筆數都跟${basis}一樣。`
      : `  有 ${mismatches.length} 項對不上。`,
  )
  process.stderr.write(lines.join('\n') + '\n')
  process.stdout.write(JSON.stringify({ tables: rows.length, mismatches }) + '\n')
  process.exitCode = mismatches.length === 0 ? 0 : 3
}

function status(file) {
  const records = readRecords(file)
  const last = (kind, st) =>
    records.filter((r) => r.kind === kind && (st ? r.status === st : true)).pop()
  const fmt = (r) => (r ? `${r.finished_at ?? r.started_at}（${r.site}${r.file ? `，${r.file}` : ''}）` : '還沒有')
  const lines = []
  const okBackup = last('backup', 'ok')
  const anyBackup = last('backup')
  lines.push(`最近成功備份：${fmt(okBackup)}`)
  if (anyBackup && anyBackup.status !== 'ok') lines.push(`  ⚠️ 之後一次備份失敗：${anyBackup.finished_at}——${anyBackup.error ?? '沒有錯誤訊息'}`)
  const okDrill = last('drill', 'ok')
  const anyDrill = last('drill')
  lines.push(`最近成功還原演練：${okDrill ? `${okDrill.finished_at}（用 ${okDrill.file}）` : '還沒有'}`)
  if (anyDrill && anyDrill.status !== 'ok') lines.push(`  ⚠️ 之後一次演練失敗：${anyDrill.finished_at}——${anyDrill.error ?? '沒有錯誤訊息'}`)
  lines.push(`紀錄檔：${file}（共 ${records.length} 筆）`)
  process.stdout.write(lines.join('\n') + '\n')
}

try {
  switch (cmd) {
    case 'append':
      append(args[0], args.slice(1))
      break
    case 'lookup':
      lookup(args[0], args[1])
      break
    case 'compare':
      compare([args[0], ...args.slice(2)], args[1])
      break
    case 'status':
      status(args[0])
      break
    default:
      process.stderr.write('用法見檔頭註解。\n')
      process.exitCode = 1
  }
} catch (err) {
  process.stderr.write(`backup-record：${err.message}\n`)
  process.exitCode = 1
}
