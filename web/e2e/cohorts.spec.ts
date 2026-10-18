import { expect, test, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { createTestSession, sharedTestSession, toPlaywrightCookie } from './session'

/**
 * 票 5（#216）：建立屆別與開放註冊。「做完的樣子」三條逐條走一次：
 *
 * 1. 管理員新增屆別（代碼、名稱），列表看得到狀態。
 * 2. 可把某屆設為預設工作屆別與開放註冊屆別；各只有一個，切換時舊的自動取消。
 * 3. 沒有設開放註冊屆別時，畫面提示管理員處理，不自行猜測。
 *
 * 全程用真的表單與按鈕；重新整理後再看一次，確認是存進資料庫而不是只改畫面。
 *
 * B 階段 AD-B4（A-09）在最後加封存／解封（AC-A-25～28）。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'

test.describe.configure({ mode: 'serial' })

// 代碼只收英數與連字號、最多 20 字；每次跑都不一樣，重跑不會撞到上一次留下的屆別。
const stamp = Date.now().toString(36).toUpperCase()
const CODE_A = `E2E-${stamp}-A`
const CODE_B = `E2E-${stamp}-B`
// 封存／解封（AD-B4）用的進行中屆別；在封存那幾條才建，前面的案例看不到它。
const CODE_C = `E2E-${stamp}-C`

test.beforeAll(async () => {
  // 兩個旗標是全系唯一的狀態。先把它們清掉，第 3 條「沒有開放註冊屆別」才看得到；
  // 用 owner 連線直接改，是測試前置，不是被測的功能。
  const ownerUrl = process.env.DATABASE_URL_OWNER
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能準備屆別狀態')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    await pool.query(
      `update cohorts set is_registration_open = false, is_default_working = false
        where is_registration_open or is_default_working`,
    )
  } finally {
    await pool.end()
  }
})

async function signInAsAdmin(page: Page) {
  const session = await sharedTestSession(page.request, 'admin')
  await page.context().addCookies([toPlaywrightCookie(session.cookie, BASE_URL)])
}

function rowOf(page: Page, code: string) {
  return page.getByRole('region', { name: new RegExp(code) })
}

/**
 * 伺服器回來的那一句回饋。限定在 `<main>` 裡找：Next 的換頁播報器也用 `role="alert"`，
 * 不限定範圍會一次抓到兩個。
 */
function feedback(page: Page, role: 'status' | 'alert') {
  return page.getByRole('main').getByRole(role)
}

/** C2-06：「新增屆別」是開視窗的按鈕；視窗已開著（上一次失敗）就直接填。 */
async function createCohort(page: Page, code: string, name: string) {
  const dialog = page.getByRole('dialog', { name: '新增屆別' })
  if (!(await dialog.isVisible())) await page.getByRole('button', { name: '新增屆別' }).click()
  await dialog.getByLabel('代碼').fill(code)
  await dialog.getByLabel('名稱').fill(name)
  await dialog.getByRole('button', { name: '確定新增' }).click()
}

/** C2-06：換旗標在卡上「編輯」視窗裡；按了就送出、視窗關掉。 */
async function setFlag(page: Page, code: string, flag: '新註冊學生加入的屆別' | '後台預設查看的屆別') {
  await rowOf(page, code).getByRole('button', { name: `編輯：${code}` }).click()
  await page.getByRole('dialog', { name: `編輯${code}` }).getByRole('button', { name: `把 ${code} 設為${flag}` }).click()
}

test('沒有開放註冊屆別時，屆別頁提示管理員處理', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/dashboard/admin/cohorts')

  await expect(page.getByRole('heading', { name: '設定', exact: true })).toBeVisible()
  const notice = page.getByRole('note', { name: '尚未設定新註冊學生加入的屆別' })
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('系統不會自己猜')
})

test('新增屆別：列表出現一列，狀態是籌備中；代碼重複被擋下', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/dashboard/admin/cohorts')

  await createCohort(page, CODE_A, `${CODE_A} 測試屆`)
  await expect(feedback(page, 'status')).toContainText(`已新增屆別 ${CODE_A} 測試屆（${CODE_A}）`)
  await expect(rowOf(page, CODE_A)).toContainText('尚未開始（設定中）')
  await expect(rowOf(page, CODE_A)).toContainText(`${CODE_A} 測試屆`)
  // 成功後視窗關掉；再開是空的，可以接著建下一屆。
  await expect(page.getByRole('dialog', { name: '新增屆別' })).toBeHidden()
  await page.getByRole('button', { name: '新增屆別' }).click()
  await expect(page.getByRole('dialog', { name: '新增屆別' }).getByLabel('代碼')).toHaveValue('')

  await createCohort(page, CODE_A, '同一個代碼')
  await expect(feedback(page, 'alert')).toContainText('已經有人用了')
  // 失敗時視窗留著、剛填的字也留著，不用重打。
  await expect(page.getByRole('dialog', { name: '新增屆別' }).getByLabel('名稱')).toHaveValue('同一個代碼')
  await expect(rowOf(page, CODE_A)).toHaveCount(1)

  await createCohort(page, CODE_B, `${CODE_B} 測試屆`)
  await expect(feedback(page, 'status')).toContainText(`已新增屆別 ${CODE_B} 測試屆（${CODE_B}）`)
  await expect(rowOf(page, CODE_B)).toContainText('尚未開始（設定中）')
})

test('開放註冊屆別只有一個：交給另一屆時舊的自動取消', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/dashboard/admin/cohorts')

  await setFlag(page, CODE_A, '新註冊學生加入的屆別')
  await expect(feedback(page, 'status')).toContainText(new RegExp(`已把新註冊學生加入的屆別設為.*（${CODE_A}）`))
  await expect(rowOf(page, CODE_A)).toContainText('新註冊加入這屆')
  // 有開放註冊屆別之後，提示就不見了。
  await expect(page.getByRole('note', { name: '尚未設定新註冊學生加入的屆別' })).toHaveCount(0)

  await setFlag(page, CODE_B, '新註冊學生加入的屆別')
  await expect(feedback(page, 'status')).toContainText(new RegExp(`新註冊學生加入的屆別設為.*（${CODE_B}）；原本的.*（${CODE_A}）已自動取消`))
  await expect(rowOf(page, CODE_B)).toContainText('新註冊加入這屆')
  await expect(rowOf(page, CODE_A)).not.toContainText('新註冊加入這屆')
  await rowOf(page, CODE_A).getByRole('button', { name: `編輯：${CODE_A}` }).click()
  await expect(page.getByRole('dialog', { name: `編輯${CODE_A}` }).getByRole('button', { name: `把 ${CODE_A} 設為新註冊學生加入的屆別` })).toBeVisible()
  await page.getByRole('dialog', { name: `編輯${CODE_A}` }).getByRole('button', { name: '關閉' }).click()
  await expect(page.getByText('新註冊加入這屆')).toHaveCount(1)
})

test('預設工作屆別與開放註冊屆別是兩件事，可以是不同屆；重新整理後都還在', async ({ page }) => {
  await signInAsAdmin(page)
  await page.goto('/dashboard/admin/cohorts')

  await setFlag(page, CODE_A, '後台預設查看的屆別')
  await expect(feedback(page, 'status')).toContainText(new RegExp(`已把後台預設查看的屆別設為.*（${CODE_A}）`))

  await setFlag(page, CODE_B, '後台預設查看的屆別')
  await expect(feedback(page, 'status')).toContainText(new RegExp(`原本的.*（${CODE_A}）已自動取消`))

  await setFlag(page, CODE_A, '後台預設查看的屆別')
  await expect(feedback(page, 'status')).toContainText(new RegExp(`原本的.*（${CODE_B}）已自動取消`))

  // 離開再回來：存在資料庫，不是只改了畫面。
  await page.reload()
  await expect(rowOf(page, CODE_A)).toContainText('後台預設查看中')
  await expect(rowOf(page, CODE_A)).not.toContainText('新註冊加入這屆')
  await expect(rowOf(page, CODE_B)).toContainText('新註冊加入這屆')
  await expect(rowOf(page, CODE_B)).not.toContainText('後台預設查看中')
  await expect(page.getByText('後台預設查看中')).toHaveCount(1)
  await expect(page.getByText('新註冊加入這屆')).toHaveCount(1)
})

test.describe('手機寬度', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('屆別表格自己橫向捲，頁面本體不捲', async ({ page }) => {
    await signInAsAdmin(page)
    await page.goto('/dashboard/admin/cohorts')
    await expect(rowOf(page, CODE_A)).toHaveCount(1)

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    expect(overflows, '窄螢幕不應該出現橫向捲動').toBe(false)
  })
})

/**
 * AD-B4 封存／解封（設計方案 §7；AC-A-25～28）。
 *
 * 進行中的屆別用 owner 連線直接建（轉進行中要先設階段，不是這裡要測的），封存與解封全走畫面。
 * 「老師評分隊列不列已封存屆別」是既有守衛（`pg-grading.ts` 的 `c.status <> 'archived'`），這裡不重建評分資料。
 */
test.describe('封存與解封', () => {
  let pool: Pool
  let cohortC: string

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 1 })
    // 每組 1 人：學生頁的「發起提案」不用填同學學號，按下去就會打到用例（AC-A-28）。
    const created = await pool.query<{ id: string }>(
      `insert into cohorts (id, code, name, status, year_end_date, group_size_min, group_size_max, created_by_kind)
       values (gen_random_uuid(), $1, $2, 'active', current_date + 300, 1, 1, 'system') returning id`,
      [CODE_C, `${CODE_C} 封存測試`],
    )
    cohortC = created.rows[0]!.id
  })

  test.afterAll(async () => {
    await pool?.end()
  })

  async function openStatusDialog(page: Page, button: '封存' | '恢復', name: string) {
    await rowOf(page, CODE_C).getByRole('button', { name: `${button}：${CODE_C}` }).click()
    const dialog = page.getByRole('dialog', { name })
    await expect(dialog).toBeVisible()
    return dialog
  }

  /** 卡上「封存」disabled，旁邊小字與按鈕 `title` 是同一句（AC-C2-14）。 */
  async function expectArchiveBlocked(page: Page, code: string, reason: string) {
    const button = rowOf(page, code).getByRole('button', { name: `封存：${code}` })
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('title', reason)
    await expect(rowOf(page, code).getByTestId('archive-blocked-reason')).toHaveText(reason)
  }

  test('AC-C2-13 卡上沒有危險區，按鈕只有「編輯」「封存」；AC-C2-14 籌備中的屆不能封存、寫原因', async ({ page }) => {
    await signInAsAdmin(page)
    await page.goto('/dashboard/admin/cohorts')

    await expect(page.getByRole('main')).not.toContainText('危險操作')
    await expect(page.getByRole('main')).not.toContainText('危險區')
    await expect(rowOf(page, CODE_C).getByRole('button')).toHaveText(['編輯', '封存'])
    await expect(rowOf(page, CODE_C).getByRole('button', { name: `封存：${CODE_C}` })).toBeEnabled()
    await expect(rowOf(page, CODE_C).getByTestId('archive-blocked-reason')).toHaveCount(0)

    // (a) 籌備中：按鈕 disabled，旁邊同一句原因。
    await expect(rowOf(page, CODE_B)).toContainText('尚未開始（設定中）')
    await expectArchiveBlocked(page, CODE_B, '還沒啟用的屆別不能封存')
  })

  test('AC-A-26／AC-C2-14 預設工作屆別不能封存：按鈕 disabled，寫「先把旗標換到別屆」，狀態不變', async ({ page }) => {
    await signInAsAdmin(page)
    await page.goto('/dashboard/admin/cohorts')

    await setFlag(page, CODE_C, '後台預設查看的屆別')
    await expect(rowOf(page, CODE_C)).toContainText('後台預設查看中')

    // (b) 預設工作屆別：按鈕 disabled，旁邊同一句原因；不用按了才在對話框報錯。
    await expectArchiveBlocked(page, CODE_C, '這一屆是預設工作屆別，先把旗標換到別屆')
    await expect(rowOf(page, CODE_C)).toContainText('進行中')

    // 預設工作屆別還給 A，下一條才封存得了。
    await setFlag(page, CODE_A, '後台預設查看的屆別')
    await expect(feedback(page, 'status')).toContainText(new RegExp(`原本的.*（${CODE_C}）已自動取消`))
    const row = await pool.query(`select status from cohorts where id = $1`, [cohortC])
    expect(row.rows[0]!.status).toBe('active')
  })

  test('AC-A-25 封存：理由選填；填了理由 → 卡片已封存、只剩「恢復」，留狀態紀錄與稽核', async ({ page }) => {
    await signInAsAdmin(page)
    await page.goto('/dashboard/admin/cohorts')

    const dialog = await openStatusDialog(page, '封存', `封存${CODE_C}？`)
    // 理由選填（C2 X2）：標籤寫明選填、不是必填欄。
    await expect(dialog.getByLabel('理由（選填，會留在操作紀錄）')).not.toHaveAttribute('aria-required')

    await dialog.getByLabel(/理由/).fill('115 學年度結束')
    await dialog.getByRole('button', { name: '確定封存' }).click()
    await expect(feedback(page, 'status')).toContainText(`已封存${CODE_C} 封存測試（${CODE_C}）`)

    // 重新整理：存在資料庫。卡上只有「已封存 {時間}」與「恢復」（C2 設計方案 §4.1），旗標按鈕都不見了。
    await page.reload()
    const card = rowOf(page, CODE_C)
    await expect(card.getByTestId('archived-at')).toContainText(/已封存 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/)
    await expect(card.getByRole('button')).toHaveCount(1)
    await expect(card.getByRole('button', { name: `恢復：${CODE_C}` })).toBeVisible()
    await expect(card.getByRole('button', { name: `恢復：${CODE_C}` })).toHaveText('恢復')

    const events = await pool.query(
      `select from_status, to_status, reason from cohort_status_events where cohort_id = $1 and to_status = 'archived'`,
      [cohortC],
    )
    expect(events.rows).toEqual([{ from_status: 'active', to_status: 'archived', reason: '115 學年度結束' }])
    const audits = await pool.query(`select count(*)::int as n from audit_events where target_id = $1 and action = 'cohort.archive'`, [
      cohortC,
    ])
    expect(audits.rows[0]!.n).toBe(1)
  })

  /** 綁在已封存的 C 的未分組學生，`openToJoin` 是他一開始的「公開找組員」開關；登入成他。 */
  async function signInAsArchivedStudent(page: Page, openToJoin: boolean) {
    const student = await createTestSession(page.request, 'student')
    const studentNo = `4${Date.now().toString().slice(-8)}`
    await pool.query(
      `insert into user_profiles (user_id, display_name, name_normalized, student_no, cohort_id, phone, contact_email, open_to_join)
       values ($1, 'e2e 封存學生', 'e2e 封存學生', $2, $3, '0912000000', $4, $5)`,
      [student.userId, studentNo, cohortC, `arch-${studentNo}@contact.example.com`, openToJoin],
    )
    await pool.query(`insert into student_identities (cohort_id, student_no, user_id) values ($1, $2, $3)`, [
      cohortC,
      studentNo,
      student.userId,
    ])
    await page.context().clearCookies()
    await page.context().addCookies([toPlaywrightCookie(student.cookie, BASE_URL)])
    return student
  }

  /** 這位學生的開關現值與「公開找組員」稽核筆數：被拒時兩者都不該變。 */
  async function openToJoinState(userId: string) {
    const flag = await pool.query(`select open_to_join from user_profiles where user_id = $1`, [userId])
    const audits = await pool.query(
      `select count(*)::int as n from audit_events where action = 'group.set_open_to_join' and actor_user_id = $1`,
      [userId],
    )
    return { open: flag.rows[0]!.open_to_join as boolean, audits: audits.rows[0]!.n as number }
  }

  test('AC-A-28 封存後學生在該屆組別頁寫入：發起提案看到「已封存」', async ({ page }) => {
    await signInAsArchivedStudent(page, false)

    await page.goto('/dashboard/student/groups')
    await page.getByRole('button', { name: '發起提案' }).click()
    await expect(feedback(page, 'alert')).toContainText('已封存')
    const proposals = await pool.query(`select count(*)::int as n from group_proposals where cohort_id = $1`, [cohortC])
    expect(proposals.rows[0]!.n).toBe(0)
  })

  test('AC-A-28 封存後按「公開找組員」：看到「已封存」，開關仍是未公開、沒有稽核', async ({ page }) => {
    const student = await signInAsArchivedStudent(page, false)

    await page.goto('/dashboard/student/groups?tab=team')
    await page.getByRole('button', { name: '公開找組員' }).click()
    await expect(feedback(page, 'alert')).toContainText('已封存')
    expect(await openToJoinState(student.userId)).toEqual({ open: false, audits: 0 })
    await page.reload()
    await expect(page.getByText('公開找組員：未公開')).toBeVisible()
  })

  test('AC-A-28 封存後按「關閉公開」：看到「已封存」，開關仍是已公開、沒有稽核', async ({ page }) => {
    const student = await signInAsArchivedStudent(page, true)

    await page.goto('/dashboard/student/groups?tab=team')
    await page.getByRole('button', { name: '關閉公開' }).click()
    await expect(feedback(page, 'alert')).toContainText('已封存')
    expect(await openToJoinState(student.userId)).toEqual({ open: true, audits: 0 })
    await page.reload()
    await expect(page.getByText('公開找組員：已公開')).toBeVisible()
  })

  test('AC-A-27 恢復（解除封存）：填理由 → 回到進行中、旗標按鈕回來，留稽核 cohort.unarchive', async ({ page }) => {
    await signInAsAdmin(page)
    await page.goto('/dashboard/admin/cohorts')

    const dialog = await openStatusDialog(page, '恢復', `恢復${CODE_C}？`)
    await dialog.getByLabel(/理由/).fill('補登成績')
    await dialog.getByRole('button', { name: '確定恢復' }).click()
    await expect(feedback(page, 'status')).toContainText(`已解除封存${CODE_C} 封存測試（${CODE_C}）`)

    await page.reload()
    await expect(rowOf(page, CODE_C)).toContainText('進行中')
    await rowOf(page, CODE_C).getByRole('button', { name: `編輯：${CODE_C}` }).click()
    await expect(page.getByRole('dialog', { name: `編輯${CODE_C}` }).getByRole('button', { name: `把 ${CODE_C} 設為後台預設查看的屆別` })).toBeVisible()
    await page.getByRole('dialog', { name: `編輯${CODE_C}` }).getByRole('button', { name: '關閉' }).click()
    await expect(rowOf(page, CODE_C).getByRole('button', { name: `封存：${CODE_C}` })).toBeVisible()

    const audits = await pool.query(
      `select count(*)::int as n from audit_events where target_id = $1 and action = 'cohort.unarchive'`,
      [cohortC],
    )
    expect(audits.rows[0]!.n).toBe(1)
  })
})
