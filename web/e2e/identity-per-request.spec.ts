import { expect, request as playwrightRequest, test } from '@playwright/test'
import { Pool } from 'pg'
import { ADMIN_HOME, STUDENT_HOME, TEACHER_HOME } from './fingerprints'
import { createTestSession, grantExtraRole } from './session'

/**
 * SH-P1：身分每個請求只驗一次（`renderActor = cache(currentActor)`），但**快取不跨請求**。
 *
 * 帳號狀態與角色直接用 owner 連線改——不經系辦畫面、也不碰 Better Auth 的 `banned`／session——
 * 這樣同一張 cookie 仍然有效，下一次請求被擋下只可能是因為 app 重新讀了 `users.status`／
 * `role_assignments`，而不是 session 被刪。快取若跨了請求，這兩條會拿到 200。
 *
 * - AC-SH-59：停用（`users.status = 'disabled'`，跟系辦「停用」寫的欄位相同）→ 下一次請求到 `/login`；
 *   恢復後再登入可進。
 * - AC-SH-60：(a) 撤銷老師角色 → 下一次請求到 `/403`；(b) 加系辦角色 → 下一次請求 `/dashboard/admin` 200。
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080'
const ownerUrl = process.env.DATABASE_URL_OWNER
const PASSWORD = 'E2e-Password-Correct-9'

// STUDENT_HOME／TEACHER_HOME／ADMIN_HOME：只有有權限的人才看得到的一段字，取自 `fingerprints.ts`。

async function owner<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  if (!ownerUrl) throw new Error('e2e 需要 DATABASE_URL_OWNER 才能改帳號狀態與角色')
  const pool = new Pool({ connectionString: ownerUrl, max: 1 })
  try {
    return await fn(pool)
  } finally {
    await pool.end()
  }
}

/**
 * 用一個**沒有 cookie jar 內容**的乾淨 context 開頁，只帶指定的那張 cookie：
 * `request` fixture 註冊後 jar 裡已經有 session，混著送就分不清是哪張 cookie 在起作用。
 * 不跟轉址，才看得到 3xx 與它要去哪。
 */
async function open(path: string, cookie: string) {
  const device = await playwrightRequest.newContext({ baseURL: BASE_URL })
  try {
    const response = await device.get(path, { headers: { cookie }, maxRedirects: 0 })
    return { status: response.status(), location: response.headers()['location'] ?? '', body: await response.text() }
  } finally {
    await device.dispose()
  }
}

test.describe.configure({ mode: 'serial' })

// 學生首頁的指紋要有屆別才出現；單跑這個檔在空庫上也要成立（同 `pages.spec.ts` 的 beforeAll）。
test.beforeAll(async () => {
  await owner(async (pool) => {
    const found = await pool.query(`select 1 from cohorts where status <> 'archived' limit 1`)
    if (found.rowCount === 0) {
      await pool.query(
        `insert into cohorts (id, code, name, status, created_by_kind)
         values (gen_random_uuid(), $1, $1, 'preparing', 'system')`,
        [`IDREQ-${Date.now().toString(36).toUpperCase()}`],
      )
    }
  })
})

test('AC-SH-59：停用在下一次請求立刻生效；恢復後再登入可進', async ({ request }) => {
  const student = await createTestSession(request, 'student')

  const before = await open('/dashboard/student', student.cookie)
  expect(before.status).toBe(200)
  expect(before.body).toContain(STUDENT_HOME)

  await owner((pool) => pool.query(`update users set status = 'disabled' where id = $1`, [student.userId]))

  // 同一張 cookie 的下一次請求：當作未登入（契約 03 §2），跟 `accounts.spec.ts:141` 一樣落在 /login。
  const after = await open('/dashboard/student', student.cookie)
  expect([302, 303, 307, 308]).toContain(after.status)
  expect(after.location).toContain('/login')
  expect(after.body, '回應裡不該有學生首頁的內容').not.toContain(STUDENT_HOME)

  // 恢復 → 用密碼重新登入，新 cookie 進得去。
  await owner((pool) => pool.query(`update users set status = 'active' where id = $1`, [student.userId]))
  // 另一個乾淨的「裝置」重新登入（同 `inbox.spec.ts`）：jar 裡帶著舊 cookie 時 Better Auth 會要 Origin。
  const device = await playwrightRequest.newContext({ baseURL: BASE_URL })
  const signIn = await device.post('/api/auth/sign-in/email', { data: { email: student.email, password: PASSWORD } })
  expect(signIn.ok(), `重新登入失敗：${signIn.status()} ${await signIn.text()}`).toBe(true)
  const cookie = (signIn.headers()['set-cookie'] ?? '').split(/,(?=[^;]+=)/)[0]!.split(';')[0]!
  await device.dispose()
  expect(cookie).not.toBe('')

  const back = await open('/dashboard/student', cookie)
  expect(back.status).toBe(200)
  expect(back.body).toContain(STUDENT_HOME)
})

test('AC-SH-60：撤銷角色、加角色都在下一次請求生效，不用重新登入', async ({ request }) => {
  const teacher = await createTestSession(request, 'teacher')

  const before = await open('/dashboard/teacher', teacher.cookie)
  expect(before.status).toBe(200)
  expect(before.body).toContain(TEACHER_HOME)

  // (a) 撤銷老師角色（帳號仍 active，`checkStatus` 只看狀態）：走 `requireRole` 的錯角色分支到 /403。
  await owner((pool) =>
    pool.query(
      `update role_assignments set revoked_real_at = now()
        where user_id = $1 and role = 'teacher' and revoked_real_at is null`,
      [teacher.userId],
    ),
  )
  const after = await open('/dashboard/teacher', teacher.cookie)
  expect([302, 303, 307, 308]).toContain(after.status)
  expect(after.location).toContain('/403')
  expect(after.body, '回應裡不該有老師首頁的內容').not.toContain(TEACHER_HOME)

  // (b) 加系辦角色：加之前打不開，加之後同一張 cookie 的下一次請求就是 200。
  const adminBefore = await open('/dashboard/admin', teacher.cookie)
  expect(adminBefore.location).toContain('/403')
  await grantExtraRole(teacher.userId, 'admin')
  const adminAfter = await open('/dashboard/admin', teacher.cookie)
  expect(adminAfter.status).toBe(200)
  expect(adminAfter.body).toContain(ADMIN_HOME)
})
