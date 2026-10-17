import { beforeEach, describe, expect, it, vi } from 'vitest'

// 登入 action 只負責「取欄位、呼叫 composition、把結果翻成畫面要的樣子」；外部全部換成假的。
const signIn = vi.fn()
const setCookie = vi.fn()
const requestPasswordReset = vi.fn()
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-real-ip': '203.0.113.9' }),
  cookies: async () => ({ set: (...args: unknown[]) => setCookie(...args) }),
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`)
  },
}))
vi.mock('@/composition/accounts', async () => ({
  signIn: (...args: unknown[]) => signIn(...args),
  beginGoogleSignIn: vi.fn(),
  clientIpFrom: (h: Headers | undefined) => h?.get('x-real-ip') ?? 'unknown',
}))
vi.mock('@/composition/password', () => ({
  requestPasswordReset: (...args: unknown[]) => requestPasswordReset(...args),
  authCallHeaders: ({ ip, turnstileToken }: { ip: string; turnstileToken?: string }) => {
    const h = new Headers({ 'x-real-ip': ip })
    if (turnstileToken) h.set('x-turnstile-token', turnstileToken)
    return h
  },
}))

const { requestPasswordResetAction, signInAction } = await import('./actions')

function form(fields: Record<string, string>): FormData {
  const data = new FormData()
  for (const [k, v] of Object.entries(fields)) data.set(k, v)
  return data
}

const PASSWORD = 'Wrong-Password-123'

describe('signInAction 失敗時', () => {
  beforeEach(() => signIn.mockReset())

  it('帶回 Email 與遞增的 attempt，讓表單保留 Email（AC-L1）', async () => {
    signIn.mockResolvedValue({ ok: false, message: 'Email 或密碼不正確。' })
    const first = await signInAction(undefined, form({ email: ' s1@mail.fju.edu.tw ', password: PASSWORD }))
    expect(first).toEqual({ error: 'Email 或密碼不正確。', values: { email: 's1@mail.fju.edu.tw' }, attempt: 1 })
    const second = await signInAction(first, form({ email: 's1@mail.fju.edu.tw', password: PASSWORD }))
    expect(second?.attempt).toBe(2)
  })

  it('回傳值不含密碼（AC-L2）', async () => {
    signIn.mockResolvedValue({ ok: false, message: 'Email 或密碼不正確。' })
    const state = await signInAction(undefined, form({ email: 's1@mail.fju.edu.tw', password: PASSWORD }))
    expect(JSON.stringify(state)).not.toContain(PASSWORD)
    expect(Object.keys(state?.values ?? {})).toEqual(['email'])
  })

  it('沒填密碼也帶回 Email，且不呼叫登入', async () => {
    const state = await signInAction(undefined, form({ email: 's1@mail.fju.edu.tw', password: '' }))
    expect(state).toEqual({ error: '請輸入 Email 與密碼。', values: { email: 's1@mail.fju.edu.tw' }, attempt: 1 })
    expect(signIn).not.toHaveBeenCalled()
  })

  it('長得離譜的 Email 不回傳', async () => {
    signIn.mockResolvedValue({ ok: false, message: 'Email 或密碼不正確。' })
    const state = await signInAction(undefined, form({ email: `${'a'.repeat(300)}@x.tw`, password: PASSWORD }))
    expect(state?.values.email).toBe('')
  })
})

describe('signInAction 成功時', () => {
  it('照舊導去目的地', async () => {
    signIn.mockResolvedValue({ ok: true, destination: '/student', mustChangePassword: false })
    await expect(signInAction(undefined, form({ email: 's1@mail.fju.edu.tw', password: PASSWORD }))).rejects.toThrow(
      'REDIRECT /student',
    )
  })
})

describe('signInAction 的一次性分析 cookie fju_ga_login（▶R2-2）', () => {
  beforeEach(() => {
    signIn.mockReset()
    setCookie.mockReset()
    vi.unstubAllEnvs()
  })

  it('成功：導頁前寫 fju_ga_login=password，Path=/、SameSite=Lax、Max-Age=60、不 HttpOnly；http 不加 Secure', async () => {
    vi.stubEnv('BETTER_AUTH_URL', 'http://127.0.0.1:3000')
    signIn.mockResolvedValue({ ok: true, destination: '/student', mustChangePassword: false })
    await expect(signInAction(undefined, form({ email: 's1@mail.fju.edu.tw', password: PASSWORD }))).rejects.toThrow('REDIRECT')
    expect(setCookie).toHaveBeenCalledTimes(1)
    expect(setCookie).toHaveBeenCalledWith('fju_ga_login', 'password', {
      path: '/',
      sameSite: 'lax',
      maxAge: 60,
      httpOnly: false,
      secure: false,
    })
  })

  it('成功且站台是 HTTPS：加 Secure；值只有登入方式，不含 Email', async () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://fju.example.edu.tw')
    signIn.mockResolvedValue({ ok: true, destination: '/account/change-password', mustChangePassword: true })
    await expect(signInAction(undefined, form({ email: 's1@mail.fju.edu.tw', password: PASSWORD }))).rejects.toThrow('REDIRECT')
    expect(setCookie.mock.calls[0]?.[2]).toMatchObject({ secure: true, httpOnly: false })
    expect(JSON.stringify(setCookie.mock.calls)).not.toContain('s1@mail.fju.edu.tw')
  })

  it('失敗（密碼錯、限速、沒填）：不寫 cookie', async () => {
    signIn.mockResolvedValue({ ok: false, message: 'Email 或密碼不正確。' })
    await signInAction(undefined, form({ email: 's1@mail.fju.edu.tw', password: PASSWORD }))
    signIn.mockResolvedValue({ ok: false, message: '嘗試過多' })
    await signInAction(undefined, form({ email: 's1@mail.fju.edu.tw', password: PASSWORD }))
    await signInAction(undefined, form({ email: 's1@mail.fju.edu.tw', password: '' }))
    expect(setCookie).not.toHaveBeenCalled()
  })
})

describe('requestPasswordResetAction（忘記密碼模式）', () => {
  beforeEach(() => {
    requestPasswordReset.mockReset()
  })
  const apiError = (code: string, message: string) => Object.assign(new Error(code), { body: { code, message } })

  it('寄出：回 sent 與 Email；Turnstile token 與 IP 帶進標頭', async () => {
    requestPasswordReset.mockResolvedValue({ status: true })
    const state = await requestPasswordResetAction(
      undefined,
      form({ email: ' s@example.com ', 'cf-turnstile-response': 'tok-1' }),
    )
    expect(state).toEqual({ status: 'sent', email: 's@example.com' })
    const [body, headers] = requestPasswordReset.mock.calls[0] as [{ email: string }, Headers]
    expect(body).toEqual({ email: 's@example.com' })
    expect(headers.get('x-turnstile-token')).toBe('tok-1')
    expect(headers.get('x-real-ip')).toBe('203.0.113.9')
  })

  it('不存在的 Email、寄信失敗、其他錯：畫面一樣是 sent（不洩漏帳號存不存在）', async () => {
    requestPasswordReset.mockResolvedValueOnce({ status: true })
    const missing = await requestPasswordResetAction(undefined, form({ email: 'nobody@example.com' }))
    requestPasswordReset.mockRejectedValueOnce(apiError('MAIL_FAILED', '驗證信寄不出去'))
    const mailFailed = await requestPasswordResetAction(undefined, form({ email: 's@example.com' }))
    requestPasswordReset.mockRejectedValueOnce(apiError('USER_NOT_FOUND', 'User not found'))
    const notFound = await requestPasswordResetAction(undefined, form({ email: 'nobody@example.com' }))
    expect(missing).toEqual({ status: 'sent', email: 'nobody@example.com' })
    expect(mailFailed).toEqual({ status: 'sent', email: 's@example.com' })
    expect(notFound).toEqual({ status: 'sent', email: 'nobody@example.com' })
  })

  it('限速 429：帶回 hook 的友善訊息與 Email（不提帳號）', async () => {
    requestPasswordReset.mockImplementation(async () => {
      throw apiError('RATE_LIMITED', '寄太多次了，請一小時後再試。')
    })
    const state = await requestPasswordResetAction(undefined, form({ email: 's@example.com' }))
    expect(state).toEqual({
      status: 'error',
      error: '寄太多次了，請一小時後再試。',
      values: { email: 's@example.com' },
      attempt: 1,
    })
  })

  it('人機驗證沒過：顯示「請完成人機驗證」，attempt 遞增', async () => {
    requestPasswordReset.mockImplementation(async () => {
      throw apiError('TURNSTILE_REQUIRED', '請完成人機驗證。')
    })
    const first = await requestPasswordResetAction(undefined, form({ email: 's@example.com' }))
    const second = await requestPasswordResetAction(first, form({ email: 's@example.com' }))
    expect(second).toMatchObject({ status: 'error', error: '請完成人機驗證。', attempt: 2 })
  })

  it('沒填或格式不對：不呼叫寄信', async () => {
    const state = await requestPasswordResetAction(undefined, form({ email: '' }))
    expect(state).toMatchObject({ status: 'error', error: '請輸入正確的 Email。' })
    expect(requestPasswordReset).not.toHaveBeenCalled()
  })
})
