import { redirect } from 'next/navigation'
import { homeFor, requireSignedIn } from '@/app/_ui/guard'
import { Card } from '@/app/_ui/primitives'
import { SignOutButton } from '@/app/_ui/sign-out'
import { NarrowShell } from '@/app/_ui/site-shell'
import {
  APPLIED_NAME_MAX_LENGTH,
  DEPARTMENT_CLASS_MAX_LENGTH,
  getRegistrationCommand,
  PASSWORD_MIN_LENGTH,
} from '@/composition/accounts'
import { formatTaipeiMinute } from '@/shared/time'
import { reviseApplicationAction } from '../actions'
import { ApplicationForm } from '../application-form'

export const metadata = { title: '等待審核｜資管系專題平台', robots: { index: false } }

/**
 * 等待審核頁（票 7；原型 `/register/pending`）。
 *
 * 待審的人登入後只到得了這一頁（其他頁的狀態閘門都把 pending 導回來）。這裡看得到：
 * 目前狀態、退回理由、送出的資料與修改紀錄，以及「修改資料」。
 *
 * 與原型的差異：
 * - **不顯示名單比對結果**。原型寫「你的學號或姓名未命中本屆名單」，那等於告訴任何人
 *   「某個學號在不在名單上」（拿別人的學號註冊再改幾次就問得出來）。比對結果只給系辦看。
 * - 沒有「核准後會寄通知信」：Email 延後，審核結果也不進通知匣（§2.4 第六輪）；
 *   重新整理或重新登入就看得到最新狀態。
 */
export default async function RegisterPendingPage({
  searchParams,
}: {
  searchParams: Promise<{ updated?: string | string[] }>
}) {
  const actor = await requireSignedIn('/register/pending', 'registration.viewOwn')
  // 已開通的人沒有待審申請可看，回自己的首頁。`homeFor` 對「已開通但還沒有角色」的人
  // （例如票 8 的預授權老師）也會回這一頁，那種情況改回首頁，免得無限導向。
  const home = homeFor(actor)
  const elsewhere = home === '/register/pending' ? '/' : home
  if (actor.status !== 'pending') redirect(elsewhere)

  const viewed = await getRegistrationCommand().viewMine(actor)
  if (!viewed.ok) redirect(elsewhere)
  const mine = viewed.receipt
  const updated = (await searchParams).updated
  const updatedRevision = typeof updated === 'string' && /^\d+$/.test(updated) ? Number(updated) : null

  const limits = {
    nameMax: APPLIED_NAME_MAX_LENGTH,
    departmentClassMax: DEPARTMENT_CLASS_MAX_LENGTH,
    passwordMin: PASSWORD_MIN_LENGTH,
  }
  const current = mine.current
  const initial = current
    ? {
        appliedName: current.appliedName,
        studentNo: current.studentNo,
        departmentClass: current.departmentClass,
        phone: current.phone,
        contactEmail: current.contactEmail,
      }
    : { appliedName: '', studentNo: '', departmentClass: '', phone: '', contactEmail: mine.loginEmail }

  return (
    <NarrowShell wide>
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-ink">
              {mine.state === 'pending' ? '等待系辦審核' : mine.state === 'rejected' ? '申請被退回' : '還沒送出申請資料'}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">登入 Email：{mine.loginEmail}</p>
          </div>
          <SignOutButton className="shrink-0 rounded-md px-3 py-1.5 text-sm text-ink hover:bg-muted" />
        </div>

        {updatedRevision !== null && mine.state === 'pending' ? (
          <p role="status" className="mt-4 rounded-md bg-primary-subtle px-3 py-2 text-sm text-primary-on-subtle">
            {updatedRevision === 1 ? '申請已送出' : `資料已更新為第 ${updatedRevision} 版`}，狀態仍是待審核；系辦會看到最新的資料。
          </p>
        ) : null}

        <div className="mt-4 rounded-md bg-muted px-4 py-3 text-sm" data-testid="application-status">
          {mine.state === 'pending' ? (
            <>
              <p className="font-medium text-ink">系辦核對名單與本人身分後才會開通。</p>
              <p className="mt-1 text-muted-foreground">
                系辦會以當面核對學生證或校方管道確認本人。開通後重新整理或重新登入，就會進入學生首頁。
              </p>
            </>
          ) : mine.state === 'rejected' && mine.rejection ? (
            <>
              <p className="font-medium text-danger-on-subtle">系辦退回了你的申請</p>
              <p className="mt-1 whitespace-pre-wrap text-ink" data-testid="rejection-reason">
                理由：{mine.rejection.reason}
              </p>
              <p className="mt-2 text-muted-foreground">
                {formatTaipeiMinute(new Date(mine.rejection.decidedAt))} 退回。請依理由修正下面的資料後重新送出，會再進入待審核。
              </p>
            </>
          ) : (
            <p className="text-ink">帳號已經建立，但申請資料還沒送到系辦。請填好下面的資料送出，才會進入待審核。</p>
          )}
        </div>

        {current && mine.state === 'pending' ? (
          <dl className="mt-4 grid grid-cols-[6rem_1fr] gap-y-2 text-sm" aria-label="目前送出的資料">
            <dt className="text-muted-foreground">姓名</dt>
            <dd className="font-medium text-ink">{current.appliedName}</dd>
            <dt className="text-muted-foreground">學號</dt>
            <dd className="font-medium tabular-nums text-ink">{current.studentNo}</dd>
            <dt className="text-muted-foreground">系級</dt>
            <dd className="font-medium text-ink">{current.departmentClass || '—'}</dd>
            <dt className="text-muted-foreground">手機</dt>
            <dd className="font-medium tabular-nums text-ink">{current.phone}</dd>
            <dt className="text-muted-foreground">聯絡 Email</dt>
            <dd className="break-all font-medium text-ink">{current.contactEmail}</dd>
            <dt className="text-muted-foreground">送出時間</dt>
            <dd className="tabular-nums text-ink">{formatTaipeiMinute(new Date(current.submittedAt))}</dd>
            <dt className="text-muted-foreground">資料版本</dt>
            <dd className="tabular-nums text-ink">第 {current.revision} 版</dd>
          </dl>
        ) : null}
      </Card>

      <div className="mt-4">
        <Card
          title={mine.state === 'pending' ? '修改資料' : mine.state === 'rejected' ? '修改後重新送出' : '送出申請資料'}
          description={
            mine.state === 'pending'
              ? '可以改姓名、學號、系級、手機與聯絡 Email。每次修改都會留紀錄，狀態仍是待審核。'
              : '屆別由系辦依名單決定，不需要填。'
          }
        >
          <ApplicationForm
            // 版本變了（或狀態變了）就重新掛上，欄位帶最新的資料。
            key={`${mine.state}-${current?.revision ?? 0}`}
            mode="revise"
            action={reviseApplicationAction}
            initial={initial}
            expectedRevision={mine.state === 'pending' ? (current?.revision ?? null) : null}
            submitLabel={mine.state === 'pending' ? '儲存修改' : '送出申請'}
            limits={limits}
          />
        </Card>
      </div>

      {mine.history.length > 1 ? (
        <div className="mt-4">
          <Card title="修改紀錄">
            <ol className="space-y-1 text-sm" aria-label="修改紀錄">
              {mine.history.map((h) => (
                <li key={h.revision} className="flex justify-between gap-3 tabular-nums">
                  <span className="text-ink">第 {h.revision} 版{h.revision === 1 ? '（送出）' : '（修改）'}</span>
                  <span className="text-muted-foreground">{formatTaipeiMinute(new Date(h.at))}</span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      ) : null}
    </NarrowShell>
  )
}
