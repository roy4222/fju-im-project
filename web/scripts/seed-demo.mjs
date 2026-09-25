#!/usr/bin/env node
/**
 * 測試站示範資料（票 32，#281）：把原型的假資料灌進測試站，讓前後台看起來跟原型差不多有內容。
 *
 *   FJU_SITE=test DATABASE_URL_OWNER=... [FILES_ROOT=...] node scripts/seed-demo.mjs            建立（已存在就不動）
 *   FJU_SITE=test DATABASE_URL_OWNER=... [FILES_ROOT=...] node scripts/seed-demo.mjs --remove   全部清掉
 *
 * 內容在 `demo/data.mjs`（照 `prototype/src/lib/fixtures.ts` 抄）。ops/deploy.sh 在 `--site test` 部署時、
 * seed-e2e 之後自動跑一次（已存在就不動）；手動跑、清掉見 ops/seed-demo.sh 與 ops/README.md。
 *
 * **只在測試站**：`FJU_SITE` 不是 `test` 就在連資料庫之前拒絕（deploy.sh、ops/seed-demo.sh 也各自只認 test）。
 *
 * 怎麼認得出示範資料：
 *   - 一個示範屆別：代碼 `DEMO-114`、名稱「示範 114 屆」，id 是固定值（`demoId('cohort')`）。
 *     組別、收件、評分、簽核、精選、活動全都掛在這一屆底下。
 *   - 示範帳號的 Email 一律是保留網域 `@demo.invalid`（老師、學生、「系辦管理員（示範）」）。
 *     **登不進來**：沒有密碼（`accounts` 沒有列）、Google 也不可能有 `.invalid` 的帳號；
 *     「系辦管理員（示範）」只是所有示範資料的建立者，狀態是停用、沒有任何角色。
 *   - 產學合作案的案主是示範老師；封面與附件的檔案擁有者是「系辦管理員（示範）」。
 *   - 每個 id 都由固定的 key 算出來（`demoId`），重跑產生一樣的 id。
 *
 * 冪等：示範屆別已經在就不寫任何東西（只把遺失的封面／附件檔案補回 FILES_ROOT）。整批寫入是同一筆交易，
 * 不會留下半套。日期照原型（原型的今天是 2026-08-17）平移到第一次種子當天的業務時間，截止日才會是「剩 9 天」。
 *
 * 不寫的東西（刻意）：
 *   - `domain_events`／通知：不可變，而且背景工作會把它投影成真的通知；示範資料不該發通知給任何人。
 *   - 簽核的逐人同意（`approvals`）：一定要掛一筆 domain event，而且畫面還沒讀它（票 26）；簽核只設版本狀態。
 *   - `due_work`（截止快照、提案到期）：不讓背景工作去動示範資料。
 *   - 稽核：只在最後寫一筆全系範圍（`scope='global'`）的 `demo.seed`，不寫屆別範圍的稽核（會擋住 --remove 刪屆別）。
 *
 * `--remove`：同一筆交易裡刪掉示範屆別底下的一切、示範帳號與它們的個人資料、示範檔案（含 FILES_ROOT 裡的實體檔）。
 * 不可變表（版本、稽核、評分紀錄……）有「連 owner 都擋」的 trigger，所以**只在這筆交易裡**以 table owner 身分
 * `ALTER TABLE … DISABLE TRIGGER USER`、刪完再 `ENABLE`（外鍵是系統 trigger，照樣檢查）。這是測試站專用的
 * owner 操作，不改任何 GRANT；交易失敗整批回滾，trigger 也跟著回到啟用。
 * 管理員在示範屆別裡操作過留下的稽核、事件、通知、操作帳本（`cohort_id` 是示範屆別的）一起刪。
 * 真資料若引用到示範資料（例如把示範學生加進真的組別、真的學生被核准進示範屆別），外鍵會擋下整批刪除，
 * 腳本印出是哪一條外鍵，什麼都不會刪——請先在後台把那筆關係解除再跑。
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import * as demo from './demo/data.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IMAGES = path.join(HERE, 'demo', 'images')

const args = process.argv.slice(2)
const unknown = args.filter((a) => a !== '--remove')
const site = process.env.FJU_SITE

// 第一件事就檢查站台：不是 test 就不往下走，連資料庫都不連。
if (site !== 'test') {
  console.error(`示範資料只放在測試站（FJU_SITE=test）；這次是「${site ?? '沒設定'}」，拒絕執行。`)
  process.exit(1)
}
if (unknown.length > 0) {
  console.error(`不認得的參數：${unknown.join(' ')}。用法：seed-demo.mjs [--remove]`)
  process.exit(1)
}
const url = process.env.DATABASE_URL_OWNER
if (!url) {
  console.error('缺少 DATABASE_URL_OWNER（示範資料要用 owner 連線寫）。')
  process.exit(1)
}
const filesRoot = process.env.FILES_ROOT ? path.resolve(process.env.FILES_ROOT) : null
const removing = args.includes('--remove')

// ── 固定 id 與小工具 ─────────────────────────────────────────────────────────

/** key → 固定的 uuid（sha256 取 128 位元，標成 v8／RFC 4122 variant）。重跑一定一樣。 */
function demoId(key) {
  const h = createHash('sha256').update(`fju-demo-seed:v1:${key}`).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const COHORT_ID = demoId('cohort')
const OFFICE_ID = demoId(`user:${demo.OFFICE.key}`)

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function json(value) {
  return { __json: value }
}

async function insert(db, table, row) {
  const cols = Object.keys(row)
  const values = cols.map((c) => {
    const v = row[c]
    return v && typeof v === 'object' && '__json' in v ? JSON.stringify(v.__json) : v
  })
  const params = cols.map((_, i) => `$${i + 1}`)
  await db.query(`insert into ${table} (${cols.join(', ')}) values (${params.join(', ')})`, values)
}

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function paragraphs(list) {
  return list.map((p) => `<p>${escapeHtml(p)}</p>`).join('')
}

function bullets(list) {
  return `<ul>${list.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
}

/** 摘要正規化（同 `application/showcase/draft.ts` 的 normalizeSummary）。 */
function normalizeSummary(summary) {
  return summary
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u3000]+$/u, ''))
    .join('\n')
    .trim()
}

/** 同 `application/ops/records.ts` 的 canonicalJson（鍵排序）。 */
function canonicalJson(value) {
  const canon = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map(canon)
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, canon(x)]),
    )
  }
  return JSON.stringify(canon(value))
}

// ── 日期：原型的「今天」平移到種子當天 ─────────────────────────────────────────

const DAY_MS = 86_400_000

/** 業務時間的現在：有模擬鐘就用最新一筆推算（跟 app 同一套），沒有就是真實時間。 */
async function businessNow(db) {
  const now = new Date()
  const latest = await db.query(
    'select business_at, real_at from business_clock_overrides order by real_at desc, id desc limit 1',
  )
  const row = latest.rows[0]
  if (!row) return now
  return new Date(new Date(row.business_at).getTime() + (now.getTime() - new Date(row.real_at).getTime()))
}

function taipeiYmd(date) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

function makeClock(anchorYmd) {
  const offsetDays = Math.round((Date.parse(`${anchorYmd}T00:00:00Z`) - Date.parse(`${demo.PROTOTYPE_TODAY}T00:00:00Z`)) / DAY_MS)
  const day = (ymd) => new Date(Date.parse(`${ymd}T00:00:00Z`) + offsetDays * DAY_MS).toISOString().slice(0, 10)
  /** 原型的「日期 時:分」（臺灣時間）→ 平移後的瞬間。 */
  const at = (ymd, hm = '10:00') => new Date(`${day(ymd)}T${hm}:00+08:00`)
  /** 「2026-08-14 16:20」這種原型字串。 */
  const stamp = (text) => at(text.slice(0, 10), text.slice(11, 16))
  return { offsetDays, day, at, stamp }
}

// ── 檔案（封面與附件）──────────────────────────────────────────────────────────

/** 一頁的示範 PDF：只有 ASCII 字「示範檔案」的英文說明，不假裝是真的範本。 */
function demoPdf(label) {
  const text = `FJU IM capstone - demo placeholder file (${label}). Not a real document.`
  const stream = `BT /F1 14 Tf 60 780 Td (${text.replace(/[()\\]/g, '')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body))
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) body += `${String(o).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/**
 * 全部示範檔案的規格（id → 名稱、類型、內容怎麼來）。種子與「補回遺失的檔」共用，所以內容一定一樣。
 * 每個檔案綁一個項目（`itemKey`）；`cover` 是公告封面。
 */
function fileSpecs() {
  const specs = []
  for (const n of demo.NEWS) {
    specs.push({ key: `file:${n.key}:cover`, itemKey: n.key, name: n.image, kind: 'jpg', source: n.image, cover: true, date: n.date })
    for (const [i, name] of (n.attachments ?? []).entries()) {
      specs.push({ key: `file:${n.key}:att${i}`, itemKey: n.key, name, kind: 'pdf', source: `${n.key}-${i + 1}`, date: n.date })
    }
  }
  for (const r of demo.RESOURCES) {
    specs.push({ key: `file:${r.key}:att0`, itemKey: r.key, name: `${r.title}.pdf`, kind: 'pdf', source: r.key, date: r.date })
  }
  for (const c of demo.COLLECTIONS) {
    for (const [i, name] of (c.attachments ?? []).entries()) {
      specs.push({ key: `file:${c.key}:att${i}`, itemKey: c.key, name, kind: 'pdf', source: `${c.key}-${i + 1}`, date: c.published })
    }
  }
  return specs.map((s) => ({ ...s, id: demoId(s.key) }))
}

async function fileBytes(spec) {
  return spec.kind === 'jpg' ? fs.readFile(path.join(IMAGES, spec.source)) : demoPdf(spec.source)
}

/** storage key 同 `application/ops/files.ts` 的 storageKeyFor：files/<UTC 年>/<UTC 月>/<id>。 */
function storageKeyFor(id, at) {
  return `files/${String(at.getUTCFullYear()).padStart(4, '0')}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/${id}`
}

function resolveInRoot(key) {
  const full = path.resolve(filesRoot, key)
  if (!full.startsWith(filesRoot + path.sep)) throw new Error(`storage key 跑出檔案根目錄：${key}`)
  return full
}

/** 把資料庫裡有、磁碟上沒有的示範檔補回去（內容由規格重算，checksum 一定對得上）。回傳補了幾個。 */
async function writeMissingFiles(db) {
  if (!filesRoot) return 0
  const specs = new Map(fileSpecs().map((s) => [s.id, s]))
  const rows = await db.query(
    `select id, storage_key, checksum from stored_files where cohort_id = $1 and owner_user_id = $2 and status = 'stored'`,
    [COHORT_ID, OFFICE_ID],
  )
  let written = 0
  for (const row of rows.rows) {
    const spec = specs.get(row.id)
    if (!spec) continue
    const full = resolveInRoot(row.storage_key)
    try {
      await fs.access(full)
      continue
    } catch {
      // 不在就補。
    }
    const bytes = await fileBytes(spec)
    if (createHash('sha256').update(bytes).digest('hex') !== row.checksum) {
      console.warn(`⚠️ 示範檔 ${spec.name} 的內容跟資料庫的 checksum 對不上，略過（換過圖檔？用 --remove 後重建）。`)
      continue
    }
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, bytes)
    written += 1
  }
  return written
}

// ── 建立 ─────────────────────────────────────────────────────────────────────

const email = (local) => `${local}@${demo.EMAIL_DOMAIN}`
const userId = (key) => demoId(`user:${key}`)
const groupId = (key) => demoId(`group:${key}`)

async function seed(db) {
  const now = await businessNow(db)
  const anchor = process.env.DEMO_ANCHOR_DATE || taipeiYmd(now)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error(`DEMO_ANCHOR_DATE 要是 YYYY-MM-DD，收到 ${anchor}`)
  const { offsetDays, day, at, stamp } = makeClock(anchor)
  const realNow = new Date()
  const counts = {}
  const count = (k, n = 1) => (counts[k] = (counts[k] ?? 0) + n)

  // ── 帳號 ──
  const addUser = async (key, name, local, { status = 'active', createdAt }) => {
    const id = userId(key)
    await insert(db, 'users', {
      id,
      name,
      email: email(local),
      email_verified: true,
      created_at: createdAt,
      updated_at: createdAt,
      banned: false,
      status,
      must_change_password: false,
    })
    count('帳號')
    return id
  }
  const role = async (uid, r, at_) => {
    await insert(db, 'role_assignments', {
      id: demoId(`role:${uid}:${r}`),
      user_id: uid,
      role: r,
      granted_by_user_id: OFFICE_ID,
      granted_real_at: at_,
      reason: 'seed:demo（測試站示範資料）',
    })
  }
  const profile = async (uid, name, contact, extra = {}) => {
    await insert(db, 'user_profiles', {
      user_id: uid,
      display_name: name,
      name_normalized: name.trim(),
      contact_email: contact,
      login_method_last: null,
      profile_completed_at: extra.completedAt ?? null,
      created_at: extra.completedAt ?? realNow,
      updated_at: extra.completedAt ?? realNow,
      updated_by_user_id: null,
      student_no: extra.studentNo ?? null,
      department_class: extra.departmentClass ?? null,
      cohort_id: extra.cohortId ?? null,
      open_to_join: extra.openToJoin ?? false,
    })
  }

  // 建立者（系辦管理員（示範））：停用、沒有角色、沒有密碼。
  const officeCreated = at('2026-07-01', '09:00')
  await addUser(demo.OFFICE.key, demo.OFFICE.name, demo.OFFICE.email, { status: 'disabled', createdAt: officeCreated })
  await profile(OFFICE_ID, demo.OFFICE.name, email(demo.OFFICE.email), { completedAt: officeCreated })

  // 屆別（先建，學生的個人資料要指過去）。兩個全系旗標都不動。
  await insert(db, 'cohorts', {
    id: COHORT_ID,
    code: demo.COHORT.code,
    name: demo.COHORT.name,
    status: 'active',
    is_default_working: false,
    is_registration_open: false,
    year_end_date: day(demo.COHORT.yearEndDate),
    proposal_default_days: 7,
    group_size_min: demo.COHORT.groupSizeMin,
    group_size_max: demo.COHORT.groupSizeMax,
    created_at: officeCreated,
    created_by_kind: 'user',
    created_by_user_id: OFFICE_ID,
    updated_at: officeCreated,
    updated_by_user_id: OFFICE_ID,
  })
  for (const s of demo.STAGES) {
    await insert(db, 'cohort_stages', {
      id: demoId(`stage:${s.seq}`),
      cohort_id: COHORT_ID,
      seq: s.seq,
      name: s.name,
      start_date: day(s.startDate),
      created_at: officeCreated,
      created_by_kind: 'user',
      created_by_user_id: OFFICE_ID,
      updated_at: officeCreated,
      updated_by_user_id: OFFICE_ID,
    })
  }
  count('階段', demo.STAGES.length)
  for (const e of demo.EVENTS) {
    await insert(db, 'project_events', {
      id: demoId(`event:${e.key}`),
      cohort_id: COHORT_ID,
      title: e.title,
      description: e.description ?? null,
      starts_at: e.allDay ? at(e.date, '00:00') : at(e.date, e.from),
      ends_at: e.allDay ? null : at(e.date, e.to),
      all_day: Boolean(e.allDay),
      audience_kind: e.audience,
      status: 'scheduled',
      created_at: officeCreated,
      created_by_kind: 'user',
      created_by_user_id: OFFICE_ID,
      updated_at: officeCreated,
      updated_by_user_id: OFFICE_ID,
    })
  }
  count('活動', demo.EVENTS.length)

  // 老師。
  for (const t of demo.TEACHERS) {
    const created = at('2026-07-01', '09:30')
    const id = await addUser(t.key, t.name, t.email, { createdAt: created })
    await role(id, 'teacher', created)
    await profile(id, t.name, email(t.email), { completedAt: created })
  }

  // 學生：已分組、未分組、停用、待審。
  const students = []
  for (const g of demo.GROUPS) for (const m of g.members) students.push(m)
  for (const u of demo.UNGROUPED) students.push(u)
  // 名單匯入、核准都在組別成立之前（組別 08-08／08-09 成立）。
  const approvedAt = at('2026-08-05', '09:00')
  for (const s of students) {
    const id = await addUser(s.key, s.name, s.studentNo, { createdAt: approvedAt })
    await role(id, 'student', approvedAt)
    await profile(id, s.name, email(s.studentNo), {
      completedAt: approvedAt,
      studentNo: s.studentNo,
      departmentClass: '資管三甲',
      cohortId: COHORT_ID,
      openToJoin: Boolean(s.openToJoin),
    })
    await insert(db, 'student_identities', { cohort_id: COHORT_ID, student_no: s.studentNo, user_id: id, created_at: approvedAt })
  }
  for (const s of demo.DISABLED) {
    const created = at('2026-08-01', '09:00')
    const id = await addUser(s.key, s.name, s.studentNo, { status: 'disabled', createdAt: created })
    await role(id, 'student', created)
    await profile(id, s.name, email(s.studentNo), { completedAt: created, studentNo: s.studentNo, cohortId: COHORT_ID })
  }

  // 名單（一版）：所有示範學生＋待審那位的名單姓名，讓待審申請比得到「學號命中、姓名不同」。
  const rosterId = demoId('roster:1')
  const rosterRows = [...students.map((s) => ({ key: s.key, studentNo: s.studentNo, name: s.name }))]
  for (const p of demo.PENDING) if (p.rosterName) rosterRows.push({ key: p.key, studentNo: p.studentNo, name: p.rosterName })
  const rosterAt = at('2026-08-04', '08:30')
  await insert(db, 'roster_versions', {
    id: rosterId,
    cohort_id: COHORT_ID,
    imported_by_user_id: OFFICE_ID,
    imported_real_at: rosterAt,
    summary: json({
      counts: { total: rosterRows.length, valid: rosterRows.length, duplicate: 0, missing: 0, conflict: 0, cohortMismatch: 0, invalidEmail: 0 },
      columns: { cohort: true, email: true, departmentClass: true },
      fileName: '示範 114 屆名單.csv',
      checksum: sha256('demo-roster'),
      issues: [],
      issuesTotal: 0,
    }),
    file_id: null,
  })
  for (const r of rosterRows) {
    await insert(db, 'roster_entries', {
      id: demoId(`roster-entry:${r.key}`),
      roster_version_id: rosterId,
      student_no: r.studentNo,
      name_raw: r.name,
      name_normalized: r.name.trim(),
      department_class: '資管三甲',
      email: email(r.studentNo),
    })
  }
  count('名單列', rosterRows.length)

  for (const p of demo.PENDING) {
    const created = at(p.created, '20:15')
    const id = await addUser(p.key, p.name, p.studentNo, { status: 'pending', createdAt: created })
    const hit = p.rosterName
      ? {
          rosterVersionId: rosterId,
          cohortId: COHORT_ID,
          cohortCode: demo.COHORT.code,
          cohortName: demo.COHORT.name,
          nameRaw: p.rosterName,
          email: email(p.studentNo),
          departmentClass: '資管三甲',
          nameMatches: false,
        }
      : null
    const match = {
      status: hit ? 'name_mismatch' : 'not_found',
      hit,
      hits: hit ? [hit] : [],
      emailComparison: hit ? 'same' : 'not_applicable',
      departmentClassComparison: hit ? 'same' : 'not_applicable',
    }
    const fields = {
      appliedName: p.name,
      studentNo: p.studentNo,
      departmentClass: '資管三甲',
      phone: '0900-000-000',
      contactEmail: email(p.studentNo),
    }
    const appId = demoId(`application:${p.key}`)
    await insert(db, 'registration_applications', {
      id: appId,
      user_id: id,
      revision: 1,
      applied_name: p.name,
      student_no: p.studentNo,
      department_class: fields.departmentClass,
      phone: fields.phone,
      contact_email: fields.contactEmail,
      login_email: email(p.studentNo),
      roster_version_id: hit ? rosterId : null,
      roster_match: json(match),
      state: 'pending',
      created_at: created,
      created_by_kind: 'user',
      created_by_user_id: id,
      updated_at: created,
      updated_by_user_id: id,
    })
    await insert(db, 'application_revisions', {
      id: demoId(`application-revision:${p.key}:1`),
      application_id: appId,
      revision: 1,
      snapshot: json({ ...fields, loginEmail: email(p.studentNo), rosterMatch: match }),
      created_at: created,
    })
  }
  count('待審申請', demo.PENDING.length)

  // ── 組別、組長、主指導、提案 ──
  for (const g of demo.GROUPS) {
    const gid = groupId(g.key)
    const est = at(g.established, '17:00')
    await insert(db, 'groups', {
      id: gid,
      cohort_id: COHORT_ID,
      code: g.code,
      group_type: g.type,
      status: 'active',
      established_real_at: est,
      established_business_at: est,
      created_at: est,
      created_by_kind: 'user',
      created_by_user_id: OFFICE_ID,
      updated_at: est,
      updated_by_user_id: OFFICE_ID,
    })
    for (const m of g.members) {
      await insert(db, 'group_memberships', {
        id: demoId(`membership:${g.key}:${m.key}`),
        group_id: gid,
        cohort_id: COHORT_ID,
        user_id: userId(m.key),
        valid_from: est,
        added_by_kind: 'user',
        added_by_user_id: OFFICE_ID,
        created_at: est,
        updated_at: est,
      })
    }
    await insert(db, 'group_leaders', {
      id: demoId(`leader:${g.key}`),
      group_id: gid,
      user_id: userId(g.members[0].key),
      valid_from: est,
      changed_by_user_id: OFFICE_ID,
      reason: '提案人成為組長',
      created_at: est,
    })
    if (g.advisor) {
      const assigned = at(g.advisorClaim ? '2026-08-16' : '2026-08-15', g.advisorClaim ? '22:05' : '10:00')
      await insert(db, 'advisor_assignments', {
        id: demoId(`advisor:${g.key}`),
        group_id: gid,
        teacher_user_id: userId(g.advisor),
        source: g.advisorClaim ? 'claim' : 'admin',
        valid_from: assigned,
        assigned_by_user_id: g.advisorClaim ? userId(g.advisor) : OFFICE_ID,
        reason: g.advisorClaim ? null : '示範：依公開抽籤結果指派',
        created_at: assigned,
      })
      count('主指導')
    }
  }
  count('組別', demo.GROUPS.length)

  const proposalId = demoId('proposal:1')
  const proposed = at(demo.PROPOSAL.created, '21:30')
  await insert(db, 'group_proposals', {
    id: proposalId,
    cohort_id: COHORT_ID,
    proposer_user_id: userId(demo.PROPOSAL.proposer),
    group_type: 'general',
    expires_business_at: new Date(proposed.getTime() + 7 * DAY_MS),
    state: 'open',
    created_real_at: proposed,
    created_business_at: proposed,
    updated_at: proposed,
  })
  for (const key of [...demo.PROPOSAL.confirmed, ...demo.PROPOSAL.pending]) {
    const confirmed = demo.PROPOSAL.confirmed.includes(key)
    await insert(db, 'proposal_invitations', {
      id: demoId(`invitation:${key}`),
      proposal_id: proposalId,
      user_id: userId(key),
      state: confirmed ? 'confirmed' : 'pending',
      decided_real_at: confirmed ? proposed : null,
      created_at: proposed,
    })
    await insert(db, 'proposal_occupancy', { user_id: userId(key), proposal_id: proposalId, created_at: proposed })
  }
  count('進行中提案')

  // ── 產學合作案與連結 ──
  for (const o of demo.INDUSTRY) {
    const published = at(o.published, '10:00')
    await insert(db, 'industry_opportunities', {
      id: demoId(`industry:${o.key}`),
      owner_teacher_user_id: userId(o.owner),
      company_name: o.company,
      department: o.department,
      content: o.content,
      requirements: o.requirements,
      notes: o.notes,
      notes_visibility: o.notes ? 'signed_in' : 'internal',
      address: o.address,
      contact_name: o.contact,
      contact_phone: o.phone,
      contact_email: o.email,
      status: 'published',
      published_business_at: published,
      created_at: published,
      created_by_kind: 'user',
      created_by_user_id: userId(o.owner),
      updated_at: published,
      updated_by_user_id: userId(o.owner),
    })
  }
  count('產學合作案', demo.INDUSTRY.length)
  for (const g of demo.GROUPS.filter((x) => x.industry)) {
    const linked = at(g.established, '18:00')
    await insert(db, 'opportunity_links', {
      id: demoId(`link:${g.key}`),
      group_id: groupId(g.key),
      opportunity_id: demoId(`industry:${g.industry}`),
      valid_from: linked,
      linked_by_user_id: userId(g.members[0].key),
      created_at: linked,
    })
  }

  // ── 專題事務：公告、規則、資源、收件 ──
  const specs = fileSpecs()
  const pendingWrites = []
  const addFile = async (spec) => {
    const bytes = await fileBytes(spec)
    const uploaded = at(spec.date, '09:30')
    const key = storageKeyFor(spec.id, uploaded)
    await insert(db, 'stored_files', {
      id: spec.id,
      owner_user_id: OFFICE_ID,
      scope: 'cohort',
      cohort_id: COHORT_ID,
      purpose: 'attachment',
      original_name: spec.name,
      size_bytes: bytes.length,
      mime_declared: spec.kind === 'jpg' ? 'image/jpeg' : 'application/pdf',
      mime_detected: spec.kind === 'jpg' ? 'image/jpeg' : 'application/pdf',
      extension: spec.kind,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      status: 'stored',
      storage_key: key,
      uploaded_real_at: uploaded,
      finalized_at: uploaded,
      created_at: uploaded,
      updated_at: uploaded,
      updated_by_user_id: OFFICE_ID,
    })
    await insert(db, 'file_references', {
      id: demoId(`file-ref:${spec.key}`),
      file_id: spec.id,
      ref_type: 'item_attachment',
      ref_id: demoId(`item:${spec.itemKey}`),
      created_at: uploaded,
    })
    pendingWrites.push({ key, bytes })
    count('檔案')
  }

  /**
   * 一個已發布的項目：頭列先以草稿插入 → 內容與欄位各切 v1 → 頭列改成發布中並指向 v1 → 發布紀錄。
   * （跟 pg-items 的發布同一個順序；不發通知、不排到期工作。）
   */
  const publishItem = async (item) => {
    const id = demoId(`item:${item.key}`)
    const opened = item.openedAt
    const itemFiles = filesRoot ? specs.filter((s) => s.itemKey === item.key) : []
    const cover = itemFiles.find((s) => s.cover) ?? null
    await insert(db, 'managed_items', {
      id,
      cohort_id: COHORT_ID,
      placement: item.placement,
      audience_kind: item.audience,
      receiver_unit: item.receiverUnit ?? 'none',
      stage_id: item.stage ? demoId(`stage:${item.stage}`) : null,
      status: 'draft',
      due_at: item.dueAt ?? null,
      title: item.title,
      summary: item.summary ?? '',
      body_html: item.bodyHtml ?? '',
      category: item.category ?? null,
      draft_schema: json({ fields: item.fields ?? [] }),
      created_at: opened,
      created_by_kind: 'user',
      created_by_user_id: OFFICE_ID,
      updated_at: opened,
      updated_by_user_id: OFFICE_ID,
    })
    for (const spec of itemFiles) await addFile(spec)
    if (cover) await db.query('update managed_items set cover_file_id = $2 where id = $1', [id, cover.id])
    let sort = 0
    for (const spec of itemFiles.filter((s) => !s.cover)) {
      await insert(db, 'item_attachments', { item_id: id, file_id: spec.id, sort: sort++, created_at: opened })
    }
    const contentId = demoId(`item-version:${item.key}:1`)
    const schemaId = demoId(`item-schema:${item.key}:1`)
    await insert(db, 'item_versions', {
      id: contentId,
      item_id: id,
      version_no: 1,
      title: item.title,
      summary: item.summary ?? '',
      body_html: item.bodyHtml ?? '',
      cover_file_id: cover?.id ?? null,
      category: item.category ?? null,
      created_by_user_id: OFFICE_ID,
      created_at: opened,
    })
    await insert(db, 'form_schema_versions', {
      id: schemaId,
      item_id: id,
      version_no: 1,
      schema: json({ fields: item.fields ?? [] }),
      created_by_user_id: OFFICE_ID,
      created_at: opened,
    })
    await db.query(
      `update managed_items
          set status = 'published', actual_opened_at = $2, current_content_version_id = $3, current_schema_version_id = $4,
              revision = revision + 1
        where id = $1`,
      [id, opened, contentId, schemaId],
    )
    await insert(db, 'item_publications', {
      id: demoId(`item-publication:${item.key}:1`),
      item_id: id,
      action: 'publish',
      content_version_id: contentId,
      schema_version_id: schemaId,
      deadline_version: item.dueAt ? 1 : null,
      notify: false,
      actor_user_id: OFFICE_ID,
      real_at: opened,
      business_at: opened,
    })
    return { id, schemaId }
  }

  // 同一天的公告照原型的順序（列表是新的在前）：排在前面的晚幾分鐘發布。
  for (const [i, n] of demo.NEWS.entries()) {
    await publishItem({
      key: n.key,
      placement: 'news',
      audience: n.audience ?? 'public',
      title: n.title,
      summary: n.summary,
      bodyHtml: paragraphs(n.body),
      category: n.category,
      openedAt: new Date(at(n.date, '10:00').getTime() + (demo.NEWS.length - i) * 60_000),
    })
  }
  count('公告', demo.NEWS.length)

  // 規則：一節一個項目，照順序發布（前台規則頁先發布的在前）。
  for (const [i, s] of demo.RULES.sections.entries()) {
    const html = [
      s.paragraphs ? paragraphs(s.paragraphs) : '',
      s.list ? bullets(s.list) : '',
      s.notes ? paragraphs(s.notes) : '',
    ].join('')
    await publishItem({
      key: `rule-${s.key}`,
      placement: 'rules',
      audience: 'public',
      title: s.heading,
      bodyHtml: html,
      openedAt: new Date(at(demo.RULES.date, '09:00').getTime() + i * 60_000),
    })
  }
  count('規則', demo.RULES.sections.length)

  for (const r of demo.RESOURCES) {
    await publishItem({
      key: r.key,
      placement: 'resource',
      audience: r.audience ?? 'signed_in',
      title: r.title,
      summary: r.summary ?? '',
      category: r.category,
      openedAt: at(r.date, '11:00'),
    })
  }
  count('資源', demo.RESOURCES.length)

  // 收件：每組一份；各組狀態照原型 GROUP_SUBMISSIONS 的算法排。
  const groupsByKey = new Map(demo.GROUPS.map((g) => [g.key, g]))
  const others = demo.GROUPS.filter((g) => g.key !== 'g-07')
  const teacherName = new Map(demo.TEACHERS.map((t) => [t.key, t.name]))
  const answersFor = (collection, g, partial) => {
    const leader = g.members[0]
    const typeLabel = g.type === 'industry' ? '產學合作' : '一般專題'
    const company = g.industry ? demo.INDUSTRY.find((o) => o.key === g.industry)?.company ?? '' : ''
    let answers
    switch (collection.key) {
      case 'mi-014': {
        const first = teacherName.get(g.advisor ?? 'u-103')
        const rest = demo.TEACHERS.map((t) => t.name).filter((n) => n !== first)
        answers = { f3: first, f4: rest[0], f5: rest[1], f6: g.title, f7: typeLabel }
        break
      }
      case 'mi-013':
        answers = { f2: leader.studentNo, f3: typeLabel, f4: ['五位組員皆為本屆學生', '已閱讀專題規則第四節'] }
        break
      case 'mi-012':
        answers = { f2: g.title, f3: g.titleEn, f4: demo.SHOWCASE_SUMMARY[g.key], f5: g.tech, ...(company ? { f6: company } : {}) }
        break
      default:
        answers = {
          f3: String(Math.min(g.members.length, 3)),
          f4: g.members.map((m) => `${m.name} ${m.studentNo}`).join('\n'),
          f5: typeLabel,
        }
    }
    if (!partial) return answers
    const [firstKey] = Object.keys(answers)
    return { [firstKey]: answers[firstKey] }
  }

  for (const [ci, c] of demo.COLLECTIONS.entries()) {
    const opened = at(c.published, '10:00')
    const dueAt = at(c.due, '23:59')
    const { id: itemId, schemaId } = await publishItem({
      key: c.key,
      placement: c.placement,
      audience: 'cohort_students',
      receiverUnit: 'group',
      stage: c.stage,
      dueAt,
      title: c.title,
      summary: c.summary,
      bodyHtml: paragraphs([c.summary]),
      fields: c.fields,
      openedAt: opened,
    })
    count('收件項目')

    // 收件名單：每一組一列（從組別成立或項目開放，較晚的那一刻起算）。
    for (const g of demo.GROUPS) {
      const from = new Date(Math.max(opened.getTime(), at(g.established, '17:00').getTime()))
      await insert(db, 'response_rosters', {
        id: demoId(`roster-row:${c.key}:${g.key}`),
        item_id: itemId,
        cohort_id: COHORT_ID,
        receiver_kind: 'group',
        receiver_id: groupId(g.key),
        eligible_from_business_at: from,
        source: 'auto',
        created_at: from,
        created_by_kind: 'user',
        created_by_user_id: OFFICE_ID,
        updated_at: from,
        updated_by_user_id: OFFICE_ID,
      })
    }

    // 各組狀態（原型 GROUP_SUBMISSIONS）：第 07 組照原型，其他組依序補到完成數與逾期數。
    const states = new Map()
    const mineDone = c.mine === 'submitted' || c.mine === 'locked'
    states.set('g-07', { state: c.mine, versions: c.mineVersions ?? [] })
    const needDone = c.progress.done - (mineDone ? 1 : 0)
    const needOverdue = c.progress.overdue
    others.forEach((g, idx) => {
      if (idx < needDone) {
        const n = ((idx + c.progress.done) % 2) + 1
        // 送出時間：從「開放且組別已成立」起算，每組、每個項目錯開幾天幾小時（原型是固定字串，這裡讓各格不一樣）。
        const afterMs = ((1 + ((idx * 3 + ci * 2) % 6)) * 24 + (idx % 10)) * 3600_000 + ((idx * 17) % 60) * 60_000
        const by = g.members[idx % g.members.length].key
        const versions = Array.from({ length: n }, (_, v) => ({ by, afterMs: afterMs - (n - 1 - v) * 30 * 3600_000 }))
        states.set(g.key, { state: 'submitted', versions })
      } else if (idx < needDone + needOverdue) {
        states.set(g.key, { state: 'overdue', versions: [] })
      } else {
        states.set(g.key, { state: idx % 2 === 0 ? 'draft' : 'todo', versions: [] })
      }
    })

    for (const [gKey, s] of states) {
      if (s.state === 'todo' || s.state === 'overdue') continue
      const g = groupsByKey.get(gKey)
      const gid = groupId(gKey)
      const answers = answersFor(c, g, s.state === 'draft')
      const earliest = new Date(Math.max(opened.getTime(), at(g.established, '17:00').getTime()) + 3600_000)
      // 不早於「開放且組別已成立」後一小時、不晚於截止與現在；同一組的版本至少差一分鐘、照順序。
      const latest = Math.min(dueAt.getTime(), now.getTime() - 3600_000)
      const times = []
      for (const v of s.versions) {
        const raw = v.at ? stamp(v.at).getTime() : earliest.getTime() + v.afterMs
        let t = Math.min(Math.max(raw, earliest.getTime()), latest)
        if (times.length > 0) t = Math.max(t, times.at(-1).getTime() + 60_000)
        times.push(new Date(t))
      }
      const draftAt = s.state === 'draft' ? new Date(Math.min(earliest.getTime() + DAY_MS, now.getTime())) : times[0]
      const draftBy = s.versions[0]?.by ?? g.members[0].key
      await insert(db, 'submission_drafts', {
        id: demoId(`draft:${c.key}:${gKey}`),
        item_id: itemId,
        receiver_kind: 'group',
        receiver_id: gid,
        schema_version_id: schemaId,
        answers: json(answers),
        revision: Math.max(1, s.versions.length),
        created_at: draftAt,
        created_by_kind: 'user',
        created_by_user_id: userId(draftBy),
        updated_at: times.at(-1) ?? draftAt,
        updated_by_user_id: userId(s.versions.at(-1)?.by ?? draftBy),
      })
      count(s.state === 'draft' ? '草稿' : '正式繳交', s.state === 'draft' ? 1 : s.versions.length)
      for (const [v, version] of s.versions.entries()) {
        await insert(db, 'submission_versions', {
          id: demoId(`submission:${c.key}:${gKey}:${v + 1}`),
          item_id: itemId,
          receiver_kind: 'group',
          receiver_id: gid,
          version_no: v + 1,
          schema_version_id: schemaId,
          answers: json(answers),
          submitted_by_user_id: userId(version.by),
          received_real_at: times[v],
          received_business_at: times[v],
          request_id: demoId(`submission-request:${c.key}:${gKey}:${v + 1}`),
          membership_snapshot: json(g.members.map((m) => userId(m.key))),
          advisor_snapshot: json({
            assignmentId: g.advisor ? demoId(`advisor:${gKey}`) : null,
            teacherUserId: g.advisor ? userId(g.advisor) : null,
          }),
          deadline_version_at_submit: 1,
        })
      }
    }
  }

  // ── 評分 ──
  const schemeId = demoId('grading-scheme')
  const schemeVersionId = demoId('grading-scheme:1')
  const schemeAt = at('2026-08-10', '09:00')
  await insert(db, 'grading_schemes', {
    id: schemeId,
    cohort_id: COHORT_ID,
    name: demo.GRADING.name,
    created_at: schemeAt,
    created_by_kind: 'user',
    created_by_user_id: OFFICE_ID,
    updated_at: schemeAt,
    updated_by_user_id: OFFICE_ID,
  })
  const firstEvaluation = demo.GRADING.assignments.filter((a) => a.state !== 'none').map((a) => stamp(a.at)).sort((a, b) => a - b)[0]
  await insert(db, 'grading_scheme_versions', {
    id: schemeVersionId,
    scheme_id: schemeId,
    version_no: 1,
    stages: json(demo.GRADING.stages),
    status: firstEvaluation ? 'locked' : 'published',
    locked_at: firstEvaluation ?? null,
    created_at: schemeAt,
    created_by_user_id: OFFICE_ID,
  })
  await db.query('update grading_schemes set current_version_id = $2 where id = $1', [schemeId, schemeVersionId])
  const assignedAt = at(demo.GRADING.assignedAt, '10:00')
  for (const g of demo.GROUPS) for (const stage of demo.GRADING.stages) {
    await insert(db, 'stage_requirements', {
      group_id: groupId(g.key),
      stage_key: stage.key,
      required_count: demo.GRADING.requiredCount,
      created_at: assignedAt,
      created_by_user_id: OFFICE_ID,
      updated_at: assignedAt,
      updated_by_user_id: OFFICE_ID,
    })
  }
  for (const a of demo.GRADING.assignments) {
    const assignmentId = demoId(`evaluator:${a.teacher}:${a.group}`)
    await insert(db, 'evaluator_assignments', {
      id: assignmentId,
      group_id: groupId(a.group),
      stage_key: 's1',
      teacher_user_id: userId(a.teacher),
      valid_from: assignedAt,
      assigned_by_user_id: OFFICE_ID,
      created_at: assignedAt,
      updated_at: assignedAt,
    })
    count('評分指派')
    if (a.state === 'none') continue
    const evaluationId = demoId(`evaluation:${a.teacher}:${a.group}`)
    const when = stamp(a.at)
    await insert(db, 'evaluations', {
      id: evaluationId,
      assignment_id: assignmentId,
      kind: a.state,
      scheme_version_id: schemeVersionId,
      scores: json(a.scores),
      submitted_real_at: when,
      submitted_business_at: when,
      request_id: demoId(`evaluation-request:${a.teacher}:${a.group}`),
    })
    const state = a.state === 'final' ? 'counted' : 'draft'
    await insert(db, 'evaluation_status', {
      evaluation_id: evaluationId,
      assignment_id: assignmentId,
      state,
      created_at: when,
      updated_at: when,
      updated_by_user_id: userId(a.teacher),
    })
    await insert(db, 'evaluation_status_events', {
      id: demoId(`evaluation-event:${a.teacher}:${a.group}`),
      evaluation_id: evaluationId,
      from_state: null,
      to_state: state,
      actor_kind: 'user',
      actor_user_id: userId(a.teacher),
      real_at: when,
    })
    count(a.state === 'final' ? '正式評分' : '暫存評分')
  }

  // ── 精選草稿（每組一份）與簽核（有主指導的組）──
  const signoffAt = at(demo.SIGNOFF.created, '10:00')
  for (const g of demo.GROUPS) {
    const entryId = demoId(`showcase:${g.key}`)
    const summary = normalizeSummary(demo.SHOWCASE_SUMMARY[g.key])
    await insert(db, 'showcase_entries', {
      id: entryId,
      cohort_id: COHORT_ID,
      group_id: groupId(g.key),
      status: 'draft',
      revision: 2,
      created_at: signoffAt,
      created_by_user_id: OFFICE_ID,
      updated_at: signoffAt,
      updated_by_user_id: OFFICE_ID,
    })
    await insert(db, 'showcase_drafts', {
      entry_id: entryId,
      title: g.title,
      summary,
      summary_checksum: sha256(summary),
      revision: 2,
      created_at: signoffAt,
      updated_at: signoffAt,
      updated_by_user_id: OFFICE_ID,
    })
    count('精選草稿')

    const state = demo.SIGNOFF.states[g.key]
    if (!state || !g.advisor) continue
    const packageId = demoId(`signoff:${g.key}`)
    const versionId = demoId(`signoff:${g.key}:1`)
    await insert(db, 'signoff_packages', {
      id: packageId,
      group_id: groupId(g.key),
      cohort_id: COHORT_ID,
      purpose: 'final_document',
      created_at: signoffAt,
      created_by_user_id: OFFICE_ID,
      updated_at: signoffAt,
      updated_by_user_id: OFFICE_ID,
    })
    const content = `<p><strong>${escapeHtml(demo.SIGNOFF.title)}</strong></p>${paragraphs(demo.SIGNOFF.body)}`
    const draftSnapshot = { title: g.title, summaryChecksum: sha256(summary), videoUrl: null, poster: null }
    const participants = {
      students: [...g.members]
        .sort((a, b) => a.studentNo.localeCompare(b.studentNo))
        .map((m) => ({ userId: userId(m.key), displayName: m.name, studentNo: m.studentNo, membershipId: demoId(`membership:${g.key}:${m.key}`) })),
      advisor: { userId: userId(g.advisor), displayName: teacherName.get(g.advisor), assignmentId: demoId(`advisor:${g.key}`) },
    }
    await insert(db, 'signoff_package_versions', {
      id: versionId,
      package_id: packageId,
      version_no: 1,
      content_text: content,
      content_checksum: sha256(content),
      attachment_file_versions: json([]),
      participants: json(participants),
      supersede_cause: null,
      authorization_scope: json({
        usages: ['public_showcase'],
        title: g.title,
        summary,
        summaryChecksum: sha256(summary),
        assets: [],
        videoUrl: null,
        validUntil: null,
        scopeSource: { entryId, draftRevision: 2, contentHash: sha256(canonicalJson(draftSnapshot)) },
      }),
      created_by_user_id: OFFICE_ID,
      created_real_at: signoffAt,
      created_business_at: signoffAt,
    })
    // 版本狀態新建只能是 collecting（trigger 守），之後再往前推。
    await insert(db, 'signoff_version_status', {
      version_id: versionId,
      state: 'collecting',
      created_at: signoffAt,
      updated_at: signoffAt,
      updated_by_user_id: OFFICE_ID,
    })
    if (state !== 'collecting') {
      const done = at('2026-08-16', '22:05')
      await db.query(
        `update signoff_version_status set state = $2, completed_real_at = $3, revision = revision + 1, updated_at = $4 where version_id = $1`,
        [versionId, state, state === 'complete' ? done : null, done],
      )
    }
    await db.query('update signoff_packages set current_version_id = $2 where id = $1', [packageId, versionId])
    count('簽核版本')
  }

  // 稽核：全系範圍一筆（不掛屆別，才不會擋住 --remove 刪屆別）。
  await insert(db, 'audit_events', {
    id: demoId(`audit:seed:${realNow.toISOString()}`),
    actor_kind: 'system',
    action: 'demo.seed',
    target_type: 'cohort',
    target_id: COHORT_ID,
    scope: 'global',
    real_at: realNow,
    business_at: now,
    payload: json({ source: 'seed:demo', site: 'test', cohortCode: demo.COHORT.code, offsetDays, counts }),
  })

  return { counts, pendingWrites, offsetDays, anchor }
}

// ── 移除 ─────────────────────────────────────────────────────────────────────

/**
 * 依外鍵順序刪。每一條只用「示範屆別／示範組別／示範項目／示範帳號」當條件，不會碰到別的資料；
 * 真資料若引用示範資料，外鍵會擋下整批（交易回滾）。
 */
const REMOVE_STEPS = [
  // 簽核與精選
  [`update signoff_packages set current_version_id = null where cohort_id = $1`],
  [`delete from approvals where version_id in (select v.id from signoff_package_versions v join signoff_packages p on p.id = v.package_id where p.cohort_id = $1)`],
  [`delete from signoff_exports where version_id in (select v.id from signoff_package_versions v join signoff_packages p on p.id = v.package_id where p.cohort_id = $1)`],
  [`delete from signoff_version_status where version_id in (select v.id from signoff_package_versions v join signoff_packages p on p.id = v.package_id where p.cohort_id = $1)`],
  [`delete from signoff_package_versions where package_id in (select id from signoff_packages where cohort_id = $1)`],
  [`delete from signoff_packages where cohort_id = $1`],
  [`update showcase_entries set current_version_id = null where cohort_id = $1`],
  [`delete from showcase_versions where entry_id in (select id from showcase_entries where cohort_id = $1)`],
  [`delete from showcase_drafts where entry_id in (select id from showcase_entries where cohort_id = $1)`],
  [`delete from showcase_entries where cohort_id = $1`],
  // 評分
  [`delete from evaluation_status_events where evaluation_id in (select e.id from evaluations e join evaluator_assignments a on a.id = e.assignment_id join groups g on g.id = a.group_id where g.cohort_id = $1)`],
  [`delete from evaluation_status where assignment_id in (select a.id from evaluator_assignments a join groups g on g.id = a.group_id where g.cohort_id = $1)`],
  [`delete from evaluations where assignment_id in (select a.id from evaluator_assignments a join groups g on g.id = a.group_id where g.cohort_id = $1)`],
  [`delete from override_review_state where override_id in (select o.id from grade_overrides o join groups g on g.id = o.group_id where g.cohort_id = $1)`],
  [`delete from grade_overrides where group_id in (select id from groups where cohort_id = $1)`],
  [`update evaluator_assignments set previous_assignment_id = null where group_id in (select id from groups where cohort_id = $1)`],
  [`delete from evaluator_assignments where group_id in (select id from groups where cohort_id = $1)`],
  [`delete from stage_requirements where group_id in (select id from groups where cohort_id = $1)`],
  [`update grading_schemes set current_version_id = null where cohort_id = $1`],
  [`delete from grading_scheme_versions where scheme_id in (select id from grading_schemes where cohort_id = $1)`],
  [`delete from grading_schemes where cohort_id = $1`],
  // 繳交與專題事務
  [`delete from submission_files where submission_version_id in (select v.id from submission_versions v join managed_items m on m.id = v.item_id where m.cohort_id = $1)`],
  [`delete from submission_versions where item_id in (select id from managed_items where cohort_id = $1)`],
  [`delete from submission_drafts where item_id in (select id from managed_items where cohort_id = $1)`],
  [`delete from advisor_visibility_settings where item_id in (select id from managed_items where cohort_id = $1)`],
  [`delete from response_rosters where cohort_id = $1 or item_id in (select id from managed_items where cohort_id = $1)`],
  // 到期工作沒有外鍵：趁項目、提案、組別都還在的時候先刪（管理員改過示範項目的截止就會有截止快照）。
  [`delete from due_work where subject_id in (select id from managed_items where cohort_id = $1 union select id from group_proposals where cohort_id = $1 union select id from groups where cohort_id = $1)`],
  [`delete from item_publications where item_id in (select id from managed_items where cohort_id = $1)`],
  [`delete from item_attachments where item_id in (select id from managed_items where cohort_id = $1)`],
  [`delete from item_audience_groups where item_id in (select id from managed_items where cohort_id = $1)`],
  [`update managed_items set status = 'draft', current_content_version_id = null, current_schema_version_id = null, cover_file_id = null where cohort_id = $1`],
  [`delete from item_versions where item_id in (select id from managed_items where cohort_id = $1)`],
  [`delete from form_schema_versions where item_id in (select id from managed_items where cohort_id = $1)`],
  [`delete from managed_items where cohort_id = $1`],
  // 產學、主指導、組別、提案
  [`update opportunity_links set previous_link_id = null where group_id in (select id from groups where cohort_id = $1)`],
  [`delete from opportunity_links where group_id in (select id from groups where cohort_id = $1)`],
  [`delete from industry_opportunities where owner_teacher_user_id in (select id from users where email like $2)`],
  [`update advisor_assignments set previous_assignment_id = null where group_id in (select id from groups where cohort_id = $1)`],
  [`delete from advisor_assignments where group_id in (select id from groups where cohort_id = $1)`],
  [`delete from group_leaders where group_id in (select id from groups where cohort_id = $1)`],
  [`delete from group_memberships where cohort_id = $1 or group_id in (select id from groups where cohort_id = $1)`],
  [`delete from proposal_occupancy where proposal_id in (select id from group_proposals where cohort_id = $1)`],
  [`delete from proposal_invitations where proposal_id in (select id from group_proposals where cohort_id = $1)`],
  [`delete from group_proposals where cohort_id = $1`],
  [`delete from groups where cohort_id = $1`],
  // 時間軸
  [`delete from project_events where cohort_id = $1`],
  [`delete from cohort_stages where cohort_id = $1`],
  [`delete from cohort_status_events where cohort_id = $1`],
  // 管理員在示範屆別裡操作留下的事件、通知、稽核、操作帳本
  [`delete from notifications where cohort_id = $1 or recipient_user_id in (select id from users where email like $2) or event_id in (select id from domain_events where cohort_id = $1)`],
  [`delete from digest_events where cohort_id = $1 or event_id in (select id from domain_events where cohort_id = $1)`],
  [`delete from event_projections where event_id in (select id from domain_events where cohort_id = $1)`],
  [`delete from domain_events where cohort_id = $1`],
  [`delete from audit_events where cohort_id = $1`],
  [`delete from operation_records where cohort_id = $1`],
  // 示範帳號
  [`delete from student_identities where cohort_id = $1 or user_id in (select id from users where email like $2)`],
  [`delete from application_revisions where application_id in (select id from registration_applications where user_id in (select id from users where email like $2))`],
  [`delete from registration_applications where user_id in (select id from users where email like $2)`],
  [`delete from roster_entries where roster_version_id in (select id from roster_versions where cohort_id = $1)`],
  [`delete from roster_versions where cohort_id = $1`],
  [`delete from role_assignments where user_id in (select id from users where email like $2)`],
  [`delete from session_revocations where user_id in (select id from users where email like $2)`],
  [`delete from user_status_events where user_id in (select id from users where email like $2)`],
  [`delete from sessions where user_id in (select id from users where email like $2)`],
  [`delete from accounts where user_id in (select id from users where email like $2)`],
  [`delete from user_profiles where user_id in (select id from users where email like $2)`],
  // 檔案（實體檔在交易之後刪）
  [`delete from file_references where file_id in (select id from stored_files where cohort_id = $1 or owner_user_id in (select id from users where email like $2))`],
  [`delete from stored_files where cohort_id = $1 or owner_user_id in (select id from users where email like $2) returning storage_key`, 'files'],
  [`delete from cohorts where id = $1`],
  [`delete from users where email like $2`],
]

async function remove(db) {
  const emailPattern = `%@${demo.EMAIL_DOMAIN}`
  const cohort = await db.query('select id, code, name from cohorts where id = $1', [COHORT_ID])
  const users = await db.query('select count(*)::int as n from users where email like $1', [emailPattern])
  if (cohort.rowCount === 0 && users.rows[0].n === 0) return null

  // 只在這筆交易裡關掉「連 owner 都擋」的 trigger（外鍵是系統 trigger，不受影響）。
  const tables = [...new Set(REMOVE_STEPS.map(([sql]) => /^(?:delete from|update) (\w+)/.exec(sql)[1]))]
  const withTriggers = await db.query(
    `select distinct c.relname as table_name
       from pg_trigger t join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.oid = any(select to_regclass(x)::oid from unnest($1::text[]) as x)`,
    [tables],
  )
  const guarded = withTriggers.rows.map((r) => r.table_name)
  for (const t of guarded) await db.query(`alter table ${t} disable trigger user`)

  const removed = {}
  const storageKeys = []
  for (const [sql, collect] of REMOVE_STEPS) {
    // $1＝示範屆別 id、$2＝示範 Email 樣式；只用到其中一個的那幾條，只帶它（PostgreSQL 推不出沒出現的參數型別）。
    const usesCohort = sql.includes('$1')
    const usesEmail = sql.includes('$2')
    const r = usesCohort
      ? await db.query(sql, usesEmail ? [COHORT_ID, emailPattern] : [COHORT_ID])
      : await db.query(sql.replaceAll('$2', '$1'), [emailPattern])
    const table = /^(?:delete from|update) (\w+)/.exec(sql)[1]
    if (sql.startsWith('delete') && r.rowCount > 0) removed[table] = (removed[table] ?? 0) + r.rowCount
    if (collect === 'files') storageKeys.push(...r.rows.map((x) => x.storage_key))
  }
  for (const t of guarded) await db.query(`alter table ${t} enable trigger user`)

  await insert(db, 'audit_events', {
    id: demoId(`audit:remove:${new Date().toISOString()}`),
    actor_kind: 'system',
    action: 'demo.remove',
    target_type: 'cohort',
    target_id: COHORT_ID,
    scope: 'global',
    real_at: new Date(),
    business_at: await businessNow(db),
    payload: json({ source: 'seed:demo', site: 'test', cohortCode: demo.COHORT.code, removed }),
  })
  return { removed, storageKeys }
}

// ── 主程式 ───────────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: url, max: 1 })
const client = await pool.connect()
let exitCode = 0
try {
  if (removing) {
    await client.query('begin')
    let result
    try {
      result = await remove(client)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      if (error && error.code === '23503') {
        console.error(
          `清不掉：有非示範的資料還引用著示範資料（外鍵 ${error.constraint ?? '?'}，表 ${error.table ?? '?'}）。` +
            '什麼都沒刪。請先在後台解除那筆關係（例如把示範學生從真的組別移出），再跑一次 --remove。',
        )
        exitCode = 1
      } else {
        throw error
      }
    }
    if (exitCode === 0) {
      if (!result) {
        console.log('沒有示範資料，不做任何事。')
      } else {
        let deleted = 0
        if (filesRoot) {
          for (const key of result.storageKeys) {
            try {
              await fs.rm(resolveInRoot(key), { force: true })
              deleted += 1
            } catch (error) {
              console.warn(`⚠️ 刪不掉實體檔 ${key}：${error.message}`)
            }
          }
        }
        const summary = Object.entries(result.removed)
          .map(([t, n]) => `${t} ${n}`)
          .join('、')
        console.log(`示範資料已清除：${summary}。`)
        if (result.storageKeys.length > 0) {
          console.log(
            filesRoot
              ? `實體檔刪了 ${deleted}／${result.storageKeys.length} 個。`
              : `沒有 FILES_ROOT：${result.storageKeys.length} 個實體檔留在檔案目錄（沒有資料庫列指向它們，無害）。`,
          )
        }
      }
    }
  } else {
    const existing = await client.query('select id, code from cohorts where id = $1 or code = $2', [COHORT_ID, demo.COHORT.code])
    if (existing.rows.some((r) => r.id === COHORT_ID)) {
      const repaired = await writeMissingFiles(client)
      console.log(`示範資料已存在（${demo.COHORT.code}），不做任何事${repaired > 0 ? `；補回 ${repaired} 個遺失的示範檔案` : ''}。`)
    } else if (existing.rowCount > 0) {
      console.error(`屆別代碼 ${demo.COHORT.code} 已經被別的屆別用了，示範資料不建。`)
      exitCode = 1
    } else {
      const taken = await client.query('select count(*)::int as n from users where email like $1', [`%@${demo.EMAIL_DOMAIN}`])
      if (taken.rows[0].n > 0) {
        console.error(`已經有 @${demo.EMAIL_DOMAIN} 的帳號但沒有示範屆別；先跑 --remove 清乾淨再建。`)
        exitCode = 1
      } else {
        await client.query('begin')
        let result
        try {
          result = await seed(client)
          await client.query('commit')
        } catch (error) {
          await client.query('rollback')
          throw error
        }
        // 交易成功後才寫實體檔；寫失敗的下次重跑會補（示範屆別已存在時只補檔）。
        let written = 0
        if (filesRoot) {
          for (const w of result.pendingWrites) {
            const full = resolveInRoot(w.key)
            await fs.mkdir(path.dirname(full), { recursive: true })
            await fs.writeFile(full, w.bytes)
            written += 1
          }
        }
        const summary = Object.entries(result.counts)
          .map(([k, n]) => `${k} ${n}`)
          .join('、')
        console.log(`示範資料已建立（${demo.COHORT.code}「${demo.COHORT.name}」，日期平移 ${result.offsetDays} 天，以 ${result.anchor} 當原型的 ${demo.PROTOTYPE_TODAY}）：${summary}。`)
        console.log(
          filesRoot
            ? `封面與附件 ${written} 個已寫進 FILES_ROOT。`
            : '沒有 FILES_ROOT：公告封面與附件略過（其他資料照建）。',
        )
        console.log(`示範屆別 id：${COHORT_ID}（後台各頁加 ?cohort=${COHORT_ID} 直接看這一屆）。`)
      }
    }
  }
} finally {
  client.release()
  await pool.end()
}
process.exit(exitCode)
