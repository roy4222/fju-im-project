/**
 * e2e 共用的頁面指紋（SH-B10）：一頁只有「真的打開了這一頁、而且有權限」才會出現的一段字。
 *
 * 否定斷言（「回應裡不該有這一頁的內容」）與正向斷言（「轉過去的頁真的是它」）都從這裡拿，
 * 頁面文字改了只要改這一處；`pages.spec.ts` 的反向對照會先紅，提醒指紋跟著改。
 */

/** 每一條受保護路由上，只有有權限的人才看得到的一段字。 */
export const FINGERPRINTS: Record<string, string> = {
  '/dashboard/admin': '作業完成率',
  '/dashboard/admin/accounts': '名單與停用',
  '/dashboard/admin/cohorts': '新註冊加入這屆',
  '/dashboard/teacher': '待辦',
  '/dashboard/student': '看完整時程',
  // 票 35 起這三頁的指紋要有屆別才出現（`pages.spec.ts` 的 beforeAll 保證有）；
  // 頁名本身不能當指紋：它也在 <title>，未授權的轉址回應裡就有。
  '/dashboard/admin/timeline': '已排定的活動',
  '/dashboard/admin/clock': '把系統認定的「今天」設到任何一秒',
  '/dashboard/admin/inbox': '全部標為已讀',
  '/dashboard/teacher/inbox': '全部標為已讀',
  '/dashboard/student/inbox': '全部標為已讀',
  '/dashboard/admin/groups': '全部組別',
  '/dashboard/student/groups': '組別分頁',
  '/dashboard/teacher/groups': '一般組由系辦指派。',
  // 合作案管理（票 20）。
  '/dashboard/admin/industry': '合作案摘要',
  '/dashboard/admin/affairs': '完整編輯器',
  // 檔案管理（票 35）。
  '/dashboard/admin/files': '編輯器加附件',
  '/dashboard/admin/editor/new': '存草稿',
  '/dashboard/student/affairs': '篩選作業',
  '/dashboard/teacher/affairs': '點小方塊看那一組每一次正式送出的內容。',
  '/dashboard/admin/grading': '成績表',
  '/dashboard/teacher/grading': '草稿只有你和系辦看得到。',
  // 簽核與精選（票 25）。
  '/dashboard/admin/signoff': '新增站內同意書',
  // 操作紀錄（票 36）。
  '/dashboard/admin/audit': '只搜近 7 天、最多 200 筆',
  '/dashboard/admin/showcase': '草稿不會公開',
  '/dashboard/student/signoff': '每個人只代表自己一票',
  // 首頁設定（第三波 W3）。
  '/dashboard/admin/home-settings': '前台首頁最上面的大圖與兩行標語',
  // 評分規則子頁（AD-08）：評分要求與指派區塊的副標，沒有評分規則時也在。
  '/dashboard/admin/grading/rules': '每組要幾份評分、指派哪位老師評',
  // 設定總頁（AD-20）：時間軸卡的說明句。
  '/dashboard/admin/settings': '四個階段與活動日期',
}

/** 三種角色的後台首頁指紋（`identity-per-request.spec.ts` 用）。 */
export const STUDENT_HOME = FINGERPRINTS['/dashboard/student']!
export const TEACHER_HOME = FINGERPRINTS['/dashboard/teacher']!
export const ADMIN_HOME = FINGERPRINTS['/dashboard/admin']!

/**
 * 前台登入後才看得到的頁（不在後台受保護路由表裡，所以不放進 FINGERPRINTS）。
 * - `/industry`：頁首說明句。
 * - `/timeline`：行事曆圖例的「臺灣時間」，不論角色、有沒有屆別都會畫出來（頁名在 `<title>` 裡，不能當指紋）。
 */
export const PUBLIC_FINGERPRINTS = {
  '/industry': '老師建立的合作案。',
  '/timeline': '臺灣時間',
} as const
