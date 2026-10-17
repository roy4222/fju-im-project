import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fillOtp, isCompleteOtp, signupFieldErrors } from './signup-checks'
import { StepBar, stepStates } from './step-bar'

describe('第 1 步的格式檢查（AC-VI-45）', () => {
  const ok = { email: 's1@example.com', password: 'a'.repeat(12), passwordConfirm: 'a'.repeat(12) }

  it('12 字、兩次相同 → 沒有錯', () => {
    expect(signupFieldErrors(ok, 12)).toEqual({})
  })

  it('11 字 → 密碼欄「密碼至少 12 字」', () => {
    expect(signupFieldErrors({ ...ok, password: 'a'.repeat(11), passwordConfirm: 'a'.repeat(11) }, 12)).toEqual({
      password: '密碼至少 12 字',
    })
  })

  it('兩次不一樣 → 確認密碼欄；Email 空白 → Email 欄', () => {
    expect(signupFieldErrors({ ...ok, email: ' ', passwordConfirm: 'b'.repeat(12) }, 12)).toEqual({
      email: '請填 Email',
      passwordConfirm: '兩次輸入的密碼不一樣',
    })
  })
})

describe('6 格驗證碼', () => {
  it('一格一個字：照位置填', () => {
    expect(fillOtp('', 0, '1')).toBe('1')
    expect(fillOtp('12', 2, '3')).toBe('123')
  })

  it('貼上整串：只取數字，從那一格往後填，超過 6 碼丟掉', () => {
    expect(fillOtp('', 0, '12 34-5678')).toBe('123456')
    expect(fillOtp('9', 1, '12345')).toBe('912345')
  })

  it('清掉中間一格：保留其他位置', () => {
    expect(fillOtp('123456', 2, '')).toBe('12 456')
    expect(isCompleteOtp('12 456')).toBe(false)
    expect(isCompleteOtp('123456')).toBe(true)
  })
})

describe('進度條三格', () => {
  it('第 1 步：第一格 current，其他 todo', () => {
    expect(stepStates(1).map((s) => s.state)).toEqual(['current', 'todo', 'todo'])
  })

  it('第 3 步：前兩格打勾；Google 來的第二格註明「Google 已驗證」', () => {
    expect(stepStates(3).map((s) => s.state)).toEqual(['done', 'done', 'current'])
    expect(stepStates(3, true)[1]).toEqual({ label: '驗證 Email', state: 'done', note: 'Google 已驗證' })
    expect(stepStates(3)[1]?.note).toBeUndefined()
  })

  it('markup：三格標籤、目前那格 aria-current="step"', () => {
    const html = renderToStaticMarkup(createElement(StepBar, { current: 2 }))
    for (const label of ['建立帳號', '驗證 Email', '填學生資料']) expect(html).toContain(label)
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-current="step" data-state="current"/)
  })
})
