import { notFound, redirect } from 'next/navigation'
import { homeFor, requireSignedIn } from '@/app/_ui/guard'
import {
  APPLIED_NAME_MAX_LENGTH,
  DEPARTMENT_CLASS_MAX_LENGTH,
  EMAIL_VERIFY_PATH,
  getRegistrationCommand,
  homeForUser,
  isRegistrationOpen,
} from '@/composition/accounts'
import { ApplicationForm } from '../application-form'
import { RegisterFrame } from '../_components/register-frame'
import { applyStepAction } from './actions'

export const metadata = { title: '填學生資料｜資管系專題平台', robots: { index: false } }

/**
 * 註冊第 3 步「填學生資料」（VB-3；visitor-r3 §3.3）。
 *
 * 姓名、學號、系級、手機、聯絡 Email（預設＝登入 Email）；**沒有密碼欄**。
 * Google 第一次登入的新帳號也直接到這裡（`?via=google`），進度條第 2 格顯示「Google 已驗證」。
 * 還沒驗證 Email 的人導回第 2 步；已經送過申請（待審或被退回）的人到等待審核頁看狀態、修改。
 */
export default async function RegisterApplyPage() {
  if (!isRegistrationOpen()) notFound()
  const actor = await requireSignedIn('/register/apply', 'registration.viewOwn')
  if (actor.status !== 'pending') redirect(homeFor(actor))
  if ((await homeForUser(actor.userId)) === EMAIL_VERIFY_PATH) redirect(EMAIL_VERIFY_PATH)

  const viewed = await getRegistrationCommand().viewMine(actor)
  if (!viewed.ok || viewed.receipt.state !== 'none') redirect('/register/pending')
  const mine = viewed.receipt
  const viaGoogle = actor.loginMethod === 'google'

  return (
    <RegisterFrame
      step={3}
      googleVerified={viaGoogle}
      title="填學生資料"
      description={
        <>
          系辦用這些資料核對身分，請和學籍資料一致。登入 Email：
          <span className="font-semibold break-all text-foreground">{mine.loginEmail}</span>
        </>
      }
    >
      <ApplicationForm
        mode="apply"
        action={applyStepAction}
        initial={{
          // Google 帶來的名字可以直接用；密碼註冊的帳號名稱只是 Email 前綴，不預填。
          appliedName: viaGoogle ? mine.accountName : '',
          studentNo: '',
          departmentClass: '',
          phone: '',
          contactEmail: mine.loginEmail,
        }}
        submitLabel="送出申請"
        limits={{ nameMax: APPLIED_NAME_MAX_LENGTH, departmentClassMax: DEPARTMENT_CLASS_MAX_LENGTH }}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        送出後會進入系辦的待審核清單，系辦以校方既有方式核對本人後才會開通。審核期間你可以登入查看狀態、修改資料。
      </p>
    </RegisterFrame>
  )
}
