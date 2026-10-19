import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createItemInDialog } from './create-item'
import { sharedTestSession, toPlaywrightCookie } from './session'

/**
 * C1-16（#640；AC-15）：公告與作業 › 檔案分頁，「用在哪裡」是連結、刪掉沒人用的檔。
 *
 * - 被公告引用的檔：刪除鈕 disabled、寫「還有 1 處在用（公告「X」附件）」；硬把 disabled 拿掉再按，命令回 `CONFLICT`、檔案不動。
 * - 沒被引用的檔：按「刪除」→ 確認一句 → 列消失；DB `soft_deleted`＋`soft_deleted_at`、稽核 `file.delete` 一筆、下載與預覽網址被拒。
 * - 首頁大圖（不寫 `file_references`）也算一處在用，不會出現在「可刪」裡。
 *
 * 公告用真的後台表單發布（附件走真的上傳）；沒被引用的檔與首頁大圖直接用 owner 連線插檔案列（刪除不碰檔案本體）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER

test.describe.configure({ mode: 'serial' })

const stamp = Date.now().toString(36).toUpperCase()
const CODE = `C116-${stamp}`
const TITLE = `${CODE} 說明會`
const USED_NAME = `c116-${stamp.toLowerCase()}-簡章.pdf`
const UNUSED_NAME = `c116-${stamp.toLowerCase()}-沒人用.pdf`
const HERO_NAME = `c116-${stamp.toLowerCase()}-首頁.png`
const PDF = Buffer.from('%PDF-1.4\n% e2e C1-16 檔案分頁\n')

let pool: Pool
let cohortId: string
let adminId: string
let itemId: string
let usedId: string
let unusedId: string

function ymd(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

async function insertStoredFile(name: string, purpose: string, scope: 'global' | 'cohort'): Promise<string> {
  const ext = name.split('.').pop()!
  const mime = ext === 'png' ? 'image/png' : 'application/pdf'
  return (
    await pool.query<{ id: string }>(
      `insert into stored_files (id, owner_user_id, scope, cohort_id, purpose, original_name, size_bytes, mime_declared, mime_detected,
                                 extension, checksum, status, storage_key, uploaded_real_at, finalized_at)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, 10, $6, $6, $7, repeat('0', 64), 'stored', 'e2e-c1-16/' || gen_random_uuid(), now(), now())
       returning id`,
      [adminId, scope, scope === 'cohort' ? cohortId : null, purpose, name, mime, ext],
    )
  ).rows[0]!.id
}

test.beforeAll(async ({ request }) => {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備與核對資料')
  pool = new Pool({ connectionString: ownerUrl, max: 2 })
  adminId = (await sharedTestSession(request, 'admin')).userId
  cohortId = (
    await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, created_by_kind)
       values (gen_random_uuid(), $1, $1, 'active', $2, 'system') returning id`,
      [CODE, ymd(new Date(Date.now() + 300 * 86_400_000))],
    )
  ).rows[0]!.id
  unusedId = await insertStoredFile(UNUSED_NAME, 'attachment', 'cohort')
})

test.afterAll(async () => {
  await pool?.end()
})

async function asAdmin(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().clearCookies()
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

const fileRow = (page: Page, name: string) => page.getByTestId('file-row').filter({ hasText: name })

test('AC-15：被公告引用的檔不能刪（按鈕寫原因、硬按也回「還有 1 處在用」）；「用在哪裡」是連結', async ({ page }) => {
  await asAdmin(page)
  await page.goto(`/dashboard/admin/affairs?cohort=${cohortId}`)
  await createItemInDialog(page, { kind: /公告/, title: TITLE, audience: 'signed_in', file: { name: USED_NAME, buffer: PDF } })
  itemId = (await pool.query<{ id: string }>('select id from managed_items where cohort_id = $1 and title = $2', [cohortId, TITLE])).rows[0]!.id
  usedId = (await pool.query<{ file_id: string }>('select file_id from item_attachments where item_id = $1', [itemId])).rows[0]!.file_id

  await page.goto('/dashboard/admin/files')
  const row = fileRow(page, USED_NAME)
  await expect(row).toHaveCount(1)
  await expect(row.getByRole('link', { name: TITLE })).toHaveAttribute('href', `/dashboard/admin/editor/${itemId}`)
  const blocked = row.getByRole('button', { name: `還有 1 處在用（公告「${TITLE}」附件）` })
  await expect(blocked).toBeDisabled()
  await expect(row.getByRole('button', { name: `刪除 ${USED_NAME}` })).toHaveCount(0)

  // 直接打刪除：把 disabled 拿掉硬按、確認 → 命令在交易裡重查引用，回 CONFLICT，檔案不動、不寫稽核。
  await blocked.evaluate((el) => el.removeAttribute('disabled'))
  await blocked.click()
  const dialog = page.getByRole('dialog', { name: '刪除檔案' })
  await dialog.getByRole('button', { name: '刪除', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('還有 1 處在用')
  const after = await pool.query('select status, soft_deleted_at from stored_files where id = $1', [usedId])
  expect(after.rows[0]).toMatchObject({ status: 'stored', soft_deleted_at: null })
  const audits = await pool.query(`select 1 from audit_events where action = 'file.delete' and target_id = $1`, [usedId])
  expect(audits.rowCount).toBe(0)
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
})

test('AC-15：沒被引用的檔按「刪除」確認後列消失；DB 標 soft_deleted、稽核 file.delete 一筆、原下載與預覽網址被拒', async ({ page }) => {
  await asAdmin(page)
  await page.goto('/dashboard/admin/files')
  const row = fileRow(page, UNUSED_NAME)
  await expect(row).toContainText('沒有用到')
  await row.getByRole('button', { name: `刪除 ${UNUSED_NAME}` }).click()
  const dialog = page.getByRole('dialog', { name: '刪除檔案' })
  await expect(dialog).toContainText(`確定刪除「${UNUSED_NAME}」？`)
  await dialog.getByRole('button', { name: '刪除', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toHaveCount(0)

  const deleted = await pool.query<{ status: string; soft_deleted_at: Date | null }>(
    'select status, soft_deleted_at from stored_files where id = $1',
    [unusedId],
  )
  expect(deleted.rows[0]!.status).toBe('soft_deleted')
  expect(deleted.rows[0]!.soft_deleted_at).not.toBeNull()
  const audits = await pool.query<{ actor_user_id: string }>(
    `select actor_user_id from audit_events where action = 'file.delete' and target_id = $1`,
    [unusedId],
  )
  expect(audits.rows).toEqual([{ actor_user_id: adminId }])

  for (const url of [`/api/files/${unusedId}`, `/api/files/${unusedId}/preview`]) {
    const response = await page.request.get(url, { maxRedirects: 0 })
    expect(response.status(), url).toBe(403)
  }

  // 重新整理後也不在清單上（清單只列 stored）。
  await page.reload()
  await expect(fileRow(page, USED_NAME)).toHaveCount(1)
  await expect(fileRow(page, UNUSED_NAME)).toHaveCount(0)
})

test('首頁大圖（沒有 file_references，由首頁設定指著）算一處在用：不可刪、按鈕寫原因', async ({ page }) => {
  const heroId = await insertStoredFile(HERO_NAME, 'photo', 'global')
  const before = await pool.query<{ hero_file_id: string | null }>('select hero_file_id from home_settings where id = 1')
  const previous = before.rows[0]?.hero_file_id ?? null
  await pool.query(
    `insert into home_settings (id, hero_file_id, updated_by_user_id) values (1, $1, $2)
     on conflict (id) do update set hero_file_id = excluded.hero_file_id`,
    [heroId, adminId],
  )
  try {
    await asAdmin(page)
    await page.goto('/dashboard/admin/files')
    const row = fileRow(page, HERO_NAME)
    await expect(row).toContainText('首頁大圖')
    await expect(row.getByRole('button', { name: '還有 1 處在用（首頁大圖）' })).toBeDisabled()
    await expect(row.getByRole('button', { name: `刪除 ${HERO_NAME}` })).toHaveCount(0)
  } finally {
    await pool.query('update home_settings set hero_file_id = $1 where id = 1', [previous])
    await pool.query(`update stored_files set status = 'soft_deleted', soft_deleted_at = now() where id = $1`, [heroId])
  }
})
