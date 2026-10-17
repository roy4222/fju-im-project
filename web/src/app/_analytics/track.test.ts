import { afterEach, describe, expect, it, vi } from 'vitest'
import { isGaEvent, loginMethodFromCookie, pageFields, sanitizeParams, setUserRole, trackEvent } from './track'
import { gaRole } from './ga-role'

describe('事件白名單（R3 四事件＋page_view）', () => {
  it('只認五個事件名', () => {
    for (const name of ['page_view', 'register_step', 'login', 'forgot_password', 'video_play']) {
      expect(isGaEvent(name)).toBe(true)
    }
    for (const name of ['scroll', 'click', 'sign_up', 'constructor', 'toString', '', 1, null]) {
      expect(isGaEvent(name)).toBe(false)
    }
  })

  it('不在白名單的事件整個不送', () => {
    expect(sanitizeParams('scroll', {})).toBeNull()
    expect(sanitizeParams('view_search_results', { search_term: '王小明' })).toBeNull()
  })

  it('沒有參數的事件：多帶的鍵全部丟掉', () => {
    expect(sanitizeParams('page_view', undefined)).toEqual({})
    expect(sanitizeParams('video_play', { project_id: 'abc', title: '作品' })).toEqual({})
    expect(sanitizeParams('forgot_password', { email: 'wang@example.com' })).toEqual({})
  })

  it('register_step 只收 1、2、3、done', () => {
    for (const step of [1, 2, 3, 'done'] as const) {
      expect(sanitizeParams('register_step', { step })).toEqual({ step })
    }
    expect(sanitizeParams('register_step', { step: 4 })).toBeNull()
    expect(sanitizeParams('register_step', { step: '1' })).toBeNull()
    expect(sanitizeParams('register_step', {})).toBeNull()
    expect(sanitizeParams('register_step', { step: 2, email: 'wang@example.com' })).toEqual({ step: 2 })
  })

  it('login 只收 google、password', () => {
    expect(sanitizeParams('login', { method: 'password' })).toEqual({ method: 'password' })
    expect(sanitizeParams('login', { method: 'google' })).toEqual({ method: 'google' })
    expect(sanitizeParams('login', { method: 'wang@example.com' })).toBeNull()
    expect(sanitizeParams('login', null)).toBeNull()
  })
})

describe('去識別的頁面欄位', () => {
  it('位置是來源＋路由名稱、referrer 空字串、標題是路由名稱', () => {
    expect(pageFields('https://fju.example', '/projects/0192f1c2-aaaa')).toEqual({
      page_location: 'https://fju.example/projects/:id',
      page_referrer: '',
      page_title: '/projects/:id',
    })
  })
})

describe('一次性登入 cookie', () => {
  it('讀得到合法值', () => {
    expect(loginMethodFromCookie('a=1; fju_ga_login=password; b=2')).toBe('password')
    expect(loginMethodFromCookie('fju_ga_login=google')).toBe('google')
  })

  it('沒有或值不合法回 null', () => {
    expect(loginMethodFromCookie('')).toBeNull()
    expect(loginMethodFromCookie('x_fju_ga_login=password')).toBeNull()
    expect(loginMethodFromCookie('fju_ga_login=wang%40example.com')).toBeNull()
    expect(loginMethodFromCookie('fju_ga_login=')).toBeNull()
  })
})

describe('trackEvent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubWindow(gtag?: (...args: unknown[]) => void) {
    vi.stubGlobal('window', { gtag, location: { origin: 'https://fju.example', pathname: '/projects/abc', search: '?q=王小明' } })
  }

  it('沒有 gtag（沒設 GA4_MEASUREMENT_ID）就什麼都不做', () => {
    stubWindow(undefined)
    expect(() => trackEvent('page_view')).not.toThrow()
  })

  it('先 set 去識別的頁面欄位，再送事件；參數只剩白名單', () => {
    const gtag = vi.fn()
    stubWindow(gtag)
    trackEvent('register_step', { step: 2, email: 'wang@example.com' } as never)
    const page = { page_location: 'https://fju.example/projects/:id', page_referrer: '', page_title: '/projects/:id' }
    expect(gtag.mock.calls).toEqual([
      ['set', page],
      ['event', 'register_step', { step: 2, ...page }],
    ])
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('王小明')
  })

  it('不合法的事件或參數不送', () => {
    const gtag = vi.fn()
    stubWindow(gtag)
    trackEvent('scroll' as never)
    trackEvent('login', { method: 'magic' } as never)
    expect(gtag).not.toHaveBeenCalled()
  })
})

describe('gaRole：只傳角色', () => {
  const base = { kind: 'authenticated' as const, userId: 'u1', mustChangePassword: false, cohortMemberships: [] }

  it('訪客 guest；待審 pending；兼任取最高', () => {
    expect(gaRole({ kind: 'anonymous' })).toBe('guest')
    expect(gaRole({ ...base, roles: [], status: 'pending' })).toBe('pending')
    expect(gaRole({ ...base, roles: [], status: 'active' })).toBe('pending')
    expect(gaRole({ ...base, roles: ['student'], status: 'active' })).toBe('student')
    expect(gaRole({ ...base, roles: ['student', 'teacher'], status: 'active' })).toBe('teacher')
    expect(gaRole({ ...base, roles: ['teacher', 'admin'], status: 'active' })).toBe('admin')
  })
})

describe('setUserRole：登入、登出後更新角色', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('set user_properties.role；沒有 gtag 或值不在枚舉就不動', () => {
    const gtag = vi.fn()
    vi.stubGlobal('window', { gtag })
    setUserRole('student')
    setUserRole('wang@example.com' as never)
    expect(gtag.mock.calls).toEqual([['set', 'user_properties', { role: 'student' }]])
    vi.stubGlobal('window', {})
    expect(() => setUserRole('guest')).not.toThrow()
  })

  it('之後的事件參數帶 user_properties.role（GA 只在角色變動時才送 up.role，光 set 不會送）', () => {
    const gtag = vi.fn()
    vi.stubGlobal('window', { gtag, location: { origin: 'https://fju.example', pathname: '/dashboard/student' } })
    setUserRole('student')
    trackEvent('page_view')
    expect(gtag.mock.calls.at(-1)).toEqual([
      'event',
      'page_view',
      {
        page_location: 'https://fju.example/dashboard/student',
        page_referrer: '',
        page_title: '/dashboard/student',
        user_properties: { role: 'student' },
      },
    ])
  })
})
