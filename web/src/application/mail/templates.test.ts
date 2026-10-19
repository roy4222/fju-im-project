import { describe, expect, it } from 'vitest'
import { emailOtpMail, passwordResetMail, registrationResultMail, reminderMail } from '@/application/mail/templates'

/** 設計方案 §3.9 的三種信；AC-VI-76 的範本段、AC-VI-53 的主旨與內文。 */
describe('信件範本', () => {
  it('驗證碼信：主旨逐字、不含任何 6 位數字；碼只在內文', () => {
    const mail = emailOtpMail('482913')
    expect(mail.template).toBe('email_otp')
    expect(mail.subject).toBe('【專題管理平台】Email 驗證碼')
    expect(mail.subject).not.toMatch(/\d{6}/)
    expect(mail.text).toBe('你的驗證碼是 482913，10 分鐘內有效。如果這不是你本人的操作，請忽略這封信。')
  })

  it('重設密碼信：主旨不含 token；連結只在內文', () => {
    const url = 'https://test.fju.roy422.dev/reset-password?token=abc123secret'
    const mail = passwordResetMail(url)
    expect(mail.template).toBe('password_reset')
    expect(mail.subject).toBe('【專題管理平台】重設密碼')
    expect(mail.subject).not.toMatch(/token|abc123secret/)
    expect(mail.text).toBe(
      `請在 30 分鐘內打開這個連結重設密碼：${url}。如果你沒有申請重設，請忽略這封信，密碼不會改變。`,
    )
  })

  it('請設定密碼信（系辦新增成員）：同一個樣板，主旨改「請設定密碼」；連結只在內文', () => {
    const url = 'https://test.fju.roy422.dev/reset-password?token=abc123secret'
    const mail = passwordResetMail(url, 'setup')
    expect(mail.template).toBe('password_reset')
    expect(mail.subject).toBe('【專題管理平台】請設定密碼')
    expect(mail.subject).not.toMatch(/token|abc123secret/)
    expect(mail.text).toBe(
      `系辦已經為你建立帳號。請在 30 分鐘內打開這個連結設定密碼：${url}。如果你不認識這個網站，請忽略這封信。`,
    )
  })

  it('核准信：連到 /login；網址結尾的斜線不會變成雙斜線', () => {
    const mail = registrationResultMail({ decision: 'approved' }, 'http://127.0.0.1:3000/')
    expect(mail.template).toBe('registration_result')
    expect(mail.subject).toBe('【專題管理平台】帳號已開通')
    expect(mail.text).toBe('你的帳號已開通，請到 http://127.0.0.1:3000/login 登入。')
  })

  it('退回信：帶理由並連到 /register/pending', () => {
    const mail = registrationResultMail({ decision: 'rejected', reason: '學號打錯' }, 'https://fju.roy422.dev')
    expect(mail.subject).toBe('【專題管理平台】註冊申請被退回')
    expect(mail.text).toBe(
      '你的註冊申請被退回。理由：學號打錯。請到 https://fju.roy422.dev/register/pending 修改後重新送出。',
    )
  })

  it('催繳信（作業）：內文同站內通知「{標題} 尚未繳交，截止 {時間}」＋連結；主旨不放作業標題', () => {
    const url = 'http://127.0.0.1:3000/dashboard/student/affairs/abc'
    const mail = reminderMail('item', { title: '期中報告', dueAt: new Date('2026-11-15T15:59:00Z'), url })
    expect(mail.template).toBe('reminder')
    expect(mail.subject).toBe('【專題管理平台】作業催繳')
    expect(mail.subject).not.toContain('期中報告')
    expect(mail.text).toBe(`期中報告 尚未繳交，截止 2026/11/15 23:59。請到 ${url} 查看並完成。`)
  })

  it('催繳信（作業沒有截止，例如站內同意書）：不寫截止', () => {
    const mail = reminderMail('item', { title: '期中結果確認', dueAt: null, url: 'https://fju.roy422.dev/x' })
    expect(mail.text).toBe('期中結果確認 尚未繳交。請到 https://fju.roy422.dev/x 查看並完成。')
  })

  it('催繳信（評分）：標題就是「您還有 N 份評分未送出」', () => {
    const url = 'https://fju.roy422.dev/dashboard/teacher/grading'
    const mail = reminderMail('grading', { title: '您還有 3 份評分未送出', dueAt: null, url })
    expect(mail.template).toBe('reminder')
    expect(mail.subject).toBe('【專題管理平台】評分催繳')
    expect(mail.text).toBe(`您還有 3 份評分未送出。請到 ${url} 完成評分並送出。`)
  })
})
