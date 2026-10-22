/**
 * e2e 共用的頁面指紋（SH-B10）：一頁只有「真的打開了這一頁、而且有權限」才會出現的一段字。
 *
 * 否定斷言（「回應裡不該有這一頁的內容」）與正向斷言（「轉過去的頁真的是它」）都從這裡拿，
 * 頁面文字改了只要改這一處；`pages.spec.ts` 的反向對照會先紅，提醒指紋跟著改。
 *
 * D-23 放寬：下面的字面值是「基底」；之後的票不改這裡，改在 `fingerprints.d/<票號>.json`（規則見那裡的 README），
 * `FINGERPRINTS` 是基底＋小檔合併後的結果。小檔撞鍵時這支在 import 時就丟錯，所有用到它的 spec 都載入失敗。
 */
import { fileURLToPath } from 'node:url'
import { mergeFromDir } from '../scripts/overlay/merge.mjs'

/** 每一條受保護路由上，只有有權限的人才看得到的一段字（基底；改用 `fingerprints.d/` 小檔）。 */
export const BASE_FINGERPRINTS: Record<string, string> = {
  '/dashboard/admin': '作業完成率',
  '/dashboard/admin/accounts': '系上所有帳號都在這裡',
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
  // C 階段規格② 的新分頁（C2-01）：指紋是分頁列下的說明句（`[data-testid="tab-intro"]`），改句子要一起改。
  // 舊設定入口頁 `/dashboard/admin/settings` 改成轉址，驗法在 `admin-redirects.spec.ts`。
  '/dashboard/admin/affairs/assignments': '要學生或組別繳交的作業與專題需求',
  '/dashboard/admin/affairs/resources': '給學生下載的範本、表單與參考資料',
  '/dashboard/admin/affairs/rules': '前台「專題規則」照這裡的順序顯示',
  '/dashboard/admin/groups/unassigned': '這一屆還沒有加入任何組別的學生。',
  '/dashboard/admin/grading/teachers': '每一組由哪幾位老師評分，以及指派與改派。',
  '/dashboard/admin/grading/settle': '把老師送出的評分結算成各階段的正式成績。',
  '/dashboard/admin/accounts/pending': '註冊後等系辦確認身分的申請',
  '/dashboard/admin/accounts/disabled': '已停用、不能登入的帳號',
  '/dashboard/admin/accounts/roster': '匯入系上提供的學生名單',
}

/** 小檔資料夾；`FINGERPRINTS_OVERLAY_DIR` 只給單元測試指到衝突 fixture 用。 */
const overlayDir = process.env.FINGERPRINTS_OVERLAY_DIR ?? fileURLToPath(new URL('./fingerprints.d', import.meta.url))

/** 基底＋小檔合併後的指紋；spec 一律用這個。 */
export const FINGERPRINTS: Record<string, string> = mergeFromDir(BASE_FINGERPRINTS, overlayDir, 'fingerprints').merged

/** 三種角色的後台首頁指紋（`identity-per-request.spec.ts` 用）。 */
export const STUDENT_HOME = FINGERPRINTS['/dashboard/student']!
export const TEACHER_HOME = FINGERPRINTS['/dashboard/teacher']!
export const ADMIN_HOME = FINGERPRINTS['/dashboard/admin']!

/**
 * 前台的頁（不在後台受保護路由表裡，所以不放進 FINGERPRINTS）。
 * - `/industry`：頁首說明句，只在這一頁出現。
 * - `/timeline`：沒有「不論角色、有沒有屆別都畫、又只在這一頁出現」的內文字（說明句是屆別名、
 *   「臺灣時間」別頁也有），改看頁面的 `<h1>`；頁名也在 `<title>` 裡，所以只能配 `h1` 用，不能拿去搜整個回應。
 */
export const SITE_FINGERPRINTS = {
  '/industry': { selector: 'body', text: '老師建立的合作案。' },
  '/timeline': { selector: 'h1', text: '專題時程' },
} as const
