import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentActor, homeFor } from '@/app/_ui/guard'
import { Card } from '@/app/_ui/primitives'
import { NarrowShell } from '@/app/_ui/site-shell'
import { APPLIED_NAME_MAX_LENGTH, DEPARTMENT_CLASS_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/composition/accounts'
import { registerAction } from './actions'
import { ApplicationForm } from './application-form'

export const metadata = { title: '註冊｜資管系專題平台' }

/**
 * 學生註冊（票 7；原型 `/register`）。
 *
 * 與原型的差異（工程模組 01 §7）：拿掉屆別欄（屆別由名單或系辦決定，Q6）、Email 改成「登入用」、
 * 聯絡 Email 預設等於登入 Email 不要求重填。Google 註冊由票 10 接上，這一頁先只有密碼。
 * 送出後一律進待審核，不論有沒有在名單上——**這一頁也不告訴你有沒有在名單上**。
 */
export default async function RegisterPage() {
  const actor = await currentActor()
  if (actor.kind === 'authenticated') {
    redirect(actor.status === 'pending' ? '/register/pending' : homeFor(actor))
  }

  return (
    <NarrowShell wide>
      <Card title="學生註冊" description="請用學籍上的姓名與學號。老師帳號由系辦建立，不需要在這裡註冊。">
        <ApplicationForm
          mode="register"
          action={registerAction}
          submitLabel="送出註冊"
          limits={{
            nameMax: APPLIED_NAME_MAX_LENGTH,
            departmentClassMax: DEPARTMENT_CLASS_MAX_LENGTH,
            passwordMin: PASSWORD_MIN_LENGTH,
          }}
        />
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          送出後帳號會進入系辦的待審核清單，系辦以校方既有方式核對本人後才會開通。
          審核期間你可以登入查看狀態、修改資料。
        </p>
      </Card>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        已經有帳號？
        <Link className="font-medium text-primary-on-subtle underline" href="/login">
          登入
        </Link>
      </p>
    </NarrowShell>
  )
}
