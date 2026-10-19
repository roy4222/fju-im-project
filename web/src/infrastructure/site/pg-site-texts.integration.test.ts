import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { assertTestDatabaseReachable, createIsolatedDatabase, poolAsRole, type IsolatedDatabase } from '../../../test/db'
import { migratedSchema } from '../../../test/migrations'
import type { ResolvedActor } from '@/application/accounts'
import { SITE_TEXT_STALE_MESSAGE, type SiteTextInput, type SiteTextKey } from '@/application/site'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'
import { PgSiteTextsCommand, PgSiteTextsQuery } from '@/infrastructure/site/pg-site-texts'

/**
 * C2-17：站內文字（規格② 設計方案 §6.5；AC-C2-40 的資料層）。
 *
 * 全部以正式執行角色 `fju_app` 連線（0022 的權限漏給 `site_texts` 的話這裡直接紅）。
 * 驗：第一次存新增列（版本 1）、之後更新（版本 2）、每個 key 各自一列；表單收斂（必填、字數）；
 * 版本過期 `CONFLICT`（另一個分頁）；同請求編號重送回原回執；稽核 `site_text.updated`；非管理員 `FORBIDDEN`；
 * 查詢一次讀全部、形狀壞掉的列當沒有。
 */

let owner: IsolatedDatabase
let app: Pool
let command: PgSiteTextsCommand
let query: PgSiteTextsQuery
let a1: string
let a2: string
let student: string
const businessClock = { now: async () => new Date('2026-10-19T02:00:00Z') }

function actor(userId: string, roles: ('admin' | 'teacher' | 'student')[]): ResolvedActor {
  return { kind: 'authenticated', userId, roles, status: 'active', mustChangePassword: false, cohortMemberships: [] }
}

let seq = 0
async function newUser(name: string, role: 'admin' | 'teacher' | 'student'): Promise<string> {
  seq += 1
  const row = await owner.sql(
    `insert into users (id, name, email, email_verified, updated_at, status)
     values (gen_random_uuid(), $1, $2, true, now(), 'active') returning id`,
    [name, `site${seq}-${randomUUID().slice(0, 8)}@example.com`],
  )
  const id = String(row.rows[0]!.id)
  await owner.sql(
    `insert into role_assignments (id, user_id, role, granted_by_user_id, granted_real_at) values (gen_random_uuid(), $1, $2, $1, now())`,
    [id, role],
  )
  return id
}

const CONTACT: SiteTextInput = {
  department: '輔仁大學資訊管理學系',
  address: '242 新北市新莊區中正路 510 號 利瑪竇大樓 LM306',
  phone: '02-2905-2666',
  siteLabel: 'im.fju.edu.tw',
  siteHref: 'https://www.im.fju.edu.tw/',
  slogan: '透過機測、專題及產業實習讓學生動手做。',
  officeNote: '專題相關事務請洽系辦公室',
  industryNote: '業界合作或產學洽詢，也請直接聯絡系辦。',
}

async function revisionOf(key: SiteTextKey): Promise<number> {
  return (await query.all())[key]?.revision ?? 0
}

async function mustSave(key: SiteTextKey, input: SiteTextInput, adminId = a1, requestId = randomUUID()) {
  const saved = await command.save(actor(adminId, ['admin']), key, input, await revisionOf(key), requestId)
  if (!saved.ok) throw new Error(`${saved.code} ${saved.message}`)
  return saved.receipt
}

beforeAll(async () => {
  await assertTestDatabaseReachable()
  owner = await createIsolatedDatabase({ label: 'site_texts', setup: migratedSchema })
  app = await poolAsRole(owner, 'fju_app')
  a1 = await newUser('系辦一', 'admin')
  a2 = await newUser('系辦二', 'admin')
  student = await newUser('學生', 'student')
  command = new PgSiteTextsCommand({ audit: new PgAuditWriter(), ledger: new PgOperationLedger(() => app), businessClock, pool: () => app })
  query = new PgSiteTextsQuery({ reader: () => app })
})

// 每個案例從「還沒存過」開始（owner 才刪得掉；app 角色沒有 delete）。
beforeEach(async () => {
  await owner.sql('delete from site_texts')
})

afterAll(async () => {
  await app?.end()
  await owner?.close()
})

describe('存檔', () => {
  it('還沒存過時什麼都沒有；第一次存新增列（版本 1），之後更新（版本 2）；記稽核 site_text.updated', async () => {
    expect(await query.all()).toEqual({})

    const first = await mustSave('footer_contact', CONTACT)
    expect(first).toMatchObject({ key: 'footer_contact', revision: 1 })
    const second = await mustSave('footer_contact', { ...CONTACT, phone: '02-2905-2000' })
    expect(second.revision).toBe(2)

    const texts = await query.all()
    expect(texts.footer_contact).toMatchObject({ key: 'footer_contact', revision: 2, value: { ...CONTACT, phone: '02-2905-2000' } })
    expect(texts.footer_contact?.updatedAt).toBeInstanceOf(Date)
    expect(texts.quick_card_2).toBeUndefined()

    const audit = await owner.sql(
      `select actor_user_id, role, target_type, payload from audit_events where action = 'site_text.updated' order by real_at`,
    )
    expect(audit.rows).toHaveLength(2)
    expect(audit.rows[1]).toMatchObject({
      actor_user_id: a1,
      role: 'admin',
      target_type: 'site_text',
      payload: { key: 'footer_contact', revision: 2, value: { phone: '02-2905-2000' } },
    })
    // 存的人記在列上。
    const row = await owner.sql(`select updated_by_user_id from site_texts where key = 'footer_contact'`)
    expect(row.rows).toEqual([{ updated_by_user_id: a1 }])
  })

  it('每個 key 各自一列、各自的版本；中間那張卡只有標題與說明', async () => {
    await mustSave('quick_card_2', { title: '我的入口', description: '登入後從這裡進後台。', href: '/x' })
    await mustSave('quick_card_2', { title: '使用平台', description: '' })
    await mustSave('quick_card_1', { title: '專題規則', description: '' })
    const texts = await query.all()
    expect(texts.quick_card_2).toMatchObject({ revision: 2, value: { title: '使用平台', description: '' } })
    expect(texts.quick_card_1).toMatchObject({ revision: 1, value: { title: '專題規則', description: '' } })
    expect(Object.keys(texts).sort()).toEqual(['quick_card_1', 'quick_card_2'])
    const stored = await owner.sql(`select value from site_texts where key = 'quick_card_2'`)
    expect(stored.rows[0]!.value).toEqual({ title: '使用平台', description: '' })
  })

  it('隱私權政策存成段落陣列', async () => {
    await mustSave('privacy', { body: '# 我們蒐集哪些資料\n\n姓名與學號。\n\n# 誰看得到\n\n系辦。' })
    expect((await query.all()).privacy?.value).toEqual({
      sections: [
        { heading: '我們蒐集哪些資料', paragraphs: ['姓名與學號。'] },
        { heading: '誰看得到', paragraphs: ['系辦。'] },
      ],
    })
  })

  it('表單收斂：必填、字數、換行都是 VALIDATION_FAILED 帶欄位名，不寫任何東西', async () => {
    const before = (await owner.sql(`select count(*)::int as n from operation_records`)).rows[0]
    const bad = await command.save(actor(a1, ['admin']), 'footer_contact', { ...CONTACT, phone: '' }, 0, randomUUID())
    expect(bad).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: '請填電話。', details: { field: 'phone' } })
    const long = await command.save(actor(a1, ['admin']), 'quick_card_3', { title: '二十一個字的標題二十一個字的標題二十一個字', description: '' }, 0, randomUUID())
    expect(long).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'title' } })
    expect(await query.all()).toEqual({})
    expect((await owner.sql(`select count(*)::int as n from operation_records`)).rows[0]).toEqual(before)
  })

  it('不認得的 key、壞的請求編號都擋', async () => {
    const key = await command.save(actor(a1, ['admin']), 'hero' as SiteTextKey, { title: 'x' }, 0, randomUUID())
    expect(key).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'key' } })
    const request = await command.save(actor(a1, ['admin']), 'quick_card_1', { title: 'x' }, 0, 'not-a-uuid')
    expect(request).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
  })
})

describe('版本與重送', () => {
  it('另一個分頁先存過：版本不符 CONFLICT、內容不變；第一次存撞主鍵也是同一句', async () => {
    await mustSave('footer_contact', CONTACT)
    const stale = await command.save(actor(a2, ['admin']), 'footer_contact', { ...CONTACT, phone: '02-0000-0000' }, 0, randomUUID())
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT', message: SITE_TEXT_STALE_MESSAGE })
    expect((await query.all()).footer_contact).toMatchObject({ revision: 1, value: { phone: CONTACT.phone } })

    const negative = await command.save(actor(a2, ['admin']), 'footer_contact', CONTACT, -1, randomUUID())
    expect(negative).toMatchObject({ ok: false, code: 'CONFLICT' })
  })

  it('同請求編號重送回原回執，不再加版本', async () => {
    const requestId = randomUUID()
    const first = await mustSave('quick_card_2', { title: '我的入口', description: '' }, a1, requestId)
    const again = await command.save(actor(a1, ['admin']), 'quick_card_2', { title: '我的入口', description: '' }, 0, requestId)
    expect(again).toMatchObject({ ok: true, receipt: { key: 'quick_card_2', revision: 1, requestId } })
    expect(again.ok && again.receipt.serverTime).toBe(first.serverTime)
    expect(await revisionOf('quick_card_2')).toBe(1)
    const mismatch = await command.save(actor(a1, ['admin']), 'quick_card_2', { title: '改了', description: '' }, 1, requestId)
    expect(mismatch).toMatchObject({ ok: false, code: 'REQUEST_MISMATCH' })
  })
})

describe('授權與讀取', () => {
  it('學生、沒登入的人不能存：FORBIDDEN／UNAUTHENTICATED，不寫任何東西', async () => {
    const forbidden = await command.save(actor(student, ['student']), 'footer_contact', CONTACT, 0, randomUUID())
    expect(forbidden).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    const anonymous = await command.save({ kind: 'anonymous' }, 'footer_contact', CONTACT, 0, randomUUID())
    expect(anonymous.ok).toBe(false)
    expect(await query.all()).toEqual({})
  })

  it('形狀壞掉的列當沒有列（畫面用預設），別的列照讀', async () => {
    await mustSave('quick_card_1', { title: '專題規則', description: '' })
    await owner.sql(`insert into site_texts (key, value, updated_by_user_id) values ('privacy', '{"sections":[]}'::jsonb, $1)`, [a1])
    const texts = await query.all()
    expect(texts.privacy).toBeUndefined()
    expect(texts.quick_card_1).toMatchObject({ value: { title: '專題規則' } })
  })
})
