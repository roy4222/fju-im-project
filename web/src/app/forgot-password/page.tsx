import { redirect } from 'next/navigation'

/**
 * 忘記密碼（visitor-r3 設計方案 §3.4，Q55）：已經併進登入卡的「忘記密碼」模式。
 *
 * 這個網址保留給首頁快速入口、頁尾與沒有 JavaScript 時的「忘記密碼？」連結：一律導到 `/login?mode=forgot`。
 */
export default function ForgotPasswordPage() {
  redirect('/login?mode=forgot')
}
