import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PasswordInput } from './password-input'

// 單元環境沒有 DOM，只驗一開始畫出來的樣子；按下去切換的行為由 e2e（login-keep-email）驗。
describe('PasswordInput 初始狀態（AC-L3）', () => {
  const html = renderToStaticMarkup(
    createElement(PasswordInput, { id: 'field-password', name: 'password', autoComplete: 'current-password' }),
  )

  it('預設隱藏，autocomplete 照呼叫端給的值', () => {
    expect(html).toMatch(/<input[^>]*type="password"/)
    expect(html).toMatch(/<input[^>]*autoComplete="current-password"/i)
    expect(html).toMatch(/<input[^>]*required/)
  })

  it('眼睛按鈕不會送出表單、有可讀的名稱與 aria-pressed', () => {
    expect(html).toMatch(/<button[^>]*type="button"/)
    expect(html).toMatch(/<button[^>]*aria-label="顯示密碼"/)
    expect(html).toMatch(/<button[^>]*aria-pressed="false"/)
    expect(html).toMatch(/<button[^>]*aria-controls="field-password"/)
  })
})
