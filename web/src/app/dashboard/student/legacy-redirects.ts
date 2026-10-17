/**
 * 學生後台拿掉的三個舊網址要轉去哪（ST-7；已定 Q126）。三個頁面檔都讀這裡，轉址目標只在這一處改。
 *
 * - 成績頁 → 學生首頁：學生本來就看不到分數（GRD-11），沒有替代頁。
 * - 後台產學頁 → 前台「產學合作」。
 * - 後台時間軸頁 → 前台「專題時程」`/timeline`（ST-6）。
 */
export const STUDENT_LEGACY_REDIRECTS = {
  '/dashboard/student/grading': '/dashboard/student',
  '/dashboard/student/industry': '/industry',
  '/dashboard/student/timeline': '/timeline',
} as const
