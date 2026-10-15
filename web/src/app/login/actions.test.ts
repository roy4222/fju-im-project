import { beforeEach, describe, expect, it, vi } from 'vitest'

// 登入 action 只負責「取欄位、呼叫 composition、把結果翻成畫面要的樣子」；外部全部換成假的。
const signIn = vi.fn()
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-real-ip': '203.0.113.9' }) }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`)
  },
}))
vi.mock('@/composition/accounts', () => ({ signIn: (...args: unknown[]) => signIn(...args), beginGoogleSignIn: vi.fn() }))

const { signInAction } = await import('./actions')

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
