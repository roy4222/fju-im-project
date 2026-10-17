import { redirect } from 'next/navigation'
import { IconAlertTriangle, IconClock } from '@tabler/icons-react'
import { homeFor, requireSignedIn } from '@/app/_ui/guard'
import { AuthCard } from '@/app/_ui/primitives'
import { PublicCard } from '@/app/_ui/public-content'
import { SignOutButton } from '@/app/_ui/sign-out'
import { SITE_CONTACT } from '@/app/_ui/site-contact'
import { NarrowShell } from '@/app/_ui/site-shell'
import {
  APPLIED_NAME_MAX_LENGTH,
  DEPARTMENT_CLASS_MAX_LENGTH,
  EMAIL_VERIFY_PATH,
  getRegistrationCommand,
  homeForUser,
  PASSWORD_MIN_LENGTH,
} from '@/composition/accounts'
import { cn } from '@/shared/cn'
import { taipeiParts } from '@/shared/time'
import { reviseApplicationAction } from '../actions'
import { ApplicationForm } from '../application-form'
import { ReviewProgress } from './_components/progress'

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
 * - 不顯示「第 N 版」（VB-5；visitor-r3 §3.5、Q44／Q33）：只說「已編輯・時間」與修改紀錄的「時間・送出／編輯」。
 *   系辦那邊的「第 N 版」照舊（核准依版本）。
 * - 三步進度＋帶證件去哪裡（VB-5）。說明句只放後半「由系辦核對，通常 1～3 個工作天。」；
 *   前半（Google Email 與名單相同立即開通）等 VB-6 啟用自動開通時一起打開。
 */
export default async function RegisterPendingPage({
  searchParams,
}: {
  searchParams: Promise<{ updated?: string | string[]; via?: string | string[] }>
}) {
  const actor = await requireSignedIn('/register/pending', 'registration.viewOwn')
  // 已開通的人沒有待審申請可看，回自己的首頁。`homeFor` 對「已開通但還沒有角色」的人
  // （例如票 8 的預授權老師）也會回這一頁，那種情況改回首頁，免得無限導向。
  const home = homeFor(actor)
  const elsewhere = home === '/register/pending' ? '/' : home
  if (actor.status !== 'pending') redirect(elsewhere)
  // 用密碼註冊、還沒驗證 Email 的人先回第 2 步（VB-3；AC-VI-50）。其他頁的狀態閘門都把待審的人帶到這裡。
  if ((await homeForUser(actor.userId)) === EMAIL_VERIFY_PATH) redirect(EMAIL_VERIFY_PATH)

  const viewed = await getRegistrationCommand().viewMine(actor)
  if (!viewed.ok) redirect(elsewhere)
  const mine = viewed.receipt
  const { updated, via } = await searchParams
  const viaGoogle = via === 'google'
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
    : { appliedName: mine.accountName, studentNo: '', departmentClass: '', phone: '', contactEmail: mine.loginEmail }

  // 最後一次修改的時間（修改紀錄新到舊；改過才有，不說是第幾版）。
  const edited = current && mine.history.length > 1 ? mine.history[0]!.at : null

  const title = mine.state === 'pending' ? '等待系辦審核' : mine.state === 'rejected' ? '申請被退回' : '還沒送出申請資料'

  return (
    <NarrowShell wide>
      <AuthCard title={title} description={`帳號已建立，尚未開通。登入 Email：${mine.loginEmail}`}>
        <div className="flex flex-col gap-5">
          {updatedRevision !== null && mine.state === 'pending' ? (
            <p role="status" className="rounded-[10px] bg-primary-subtle px-4 py-3 text-sm font-semibold text-primary-on-subtle">
              {updatedRevision === 1 ? '申請已送出' : '資料已更新'}，狀態仍是待審核；系辦會看到最新的資料。
            </p>
          ) : null}

          {mine.state !== 'none' ? <ReviewProgress rejected={mine.state === 'rejected'} /> : null}

          <div
            className={cn(
              'flex items-start gap-3.5 rounded-[10px] p-4.5',
              mine.state === 'rejected' ? 'bg-danger-subtle' : 'bg-secondary text-secondary-foreground',
            )}
            data-testid="application-status"
          >
            {mine.state === 'rejected' ? (
              <IconAlertTriangle className="mt-0.5 size-5 shrink-0 text-danger-on-subtle" aria-hidden />
            ) : (
              <IconClock className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            )}
            <div className="min-w-0 text-sm">
              {mine.state === 'pending' ? (
                <>
                  <p className="font-bold text-foreground">由系辦核對，通常 1～3 個工作天。</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    開通後重新整理或重新登入，就會進入學生首頁。
                  </p>
                </>
              ) : mine.state === 'rejected' && mine.rejection ? (
                <>
                  <p className="font-bold text-danger-on-subtle">系辦退回了你的申請</p>
                  <p className="mt-1 whitespace-pre-wrap text-foreground" data-testid="rejection-reason">
                    理由：{mine.rejection.reason}
                  </p>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                    {formatWhen(mine.rejection.decidedAt)} 退回。請依理由修正下面的資料後重新送出，會再進入待審核。
                  </p>
                </>
              ) : (
                <p className="leading-relaxed text-foreground" data-testid="application-missing">
                  帳號已經建立，但申請資料還沒送到系辦。請填好下面的姓名、學號、系級與手機送出，才會進入待審核。
                  {viaGoogle ? '（你是用 Google 第一次登入，所以還沒有這些資料。）' : null}
                </p>
              )}
            </div>
          </div>

          {current && mine.state === 'pending' ? (
            <dl className="flex flex-col gap-2 text-sm" aria-label="目前送出的資料">
              {(
                [
                  ['姓名', current.appliedName, false],
                  ['學號', current.studentNo, true],
                  ['系級', current.departmentClass || '—', false],
                  ['手機', current.phone, true],
                  ['聯絡 Email', current.contactEmail, false],
                  ['送出時間', formatWhen(current.submittedAt), true],
                  ...(edited ? ([['最後修改', `已編輯・${formatWhen(edited)}`, true]] as const) : []),
                ] as const
              ).map(([k, v, numeric]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="shrink-0 text-muted-foreground">{k}</dt>
                  <dd className={cn('min-w-0 text-right font-semibold break-all text-foreground', numeric ? 'tabular-nums' : '')}>{v}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {mine.state !== 'none' ? (
            <div className="rounded-[10px] border border-dashed border-border px-4 py-3 text-sm" data-testid="bring-id">
              <p className="font-bold text-foreground">請帶學生證到系辦核對身分</p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                {SITE_CONTACT.address}・電話{' '}
                <a href={SITE_CONTACT.phoneHref} className="font-semibold whitespace-nowrap text-primary tabular-nums hover:underline">
                  {SITE_CONTACT.phone}
                </a>
              </p>
            </div>
          ) : null}
          <p className="text-[13px] leading-relaxed text-muted-foreground">若資料填錯，可以在下面直接修改；有問題請到系辦公室（利瑪竇大樓）詢問。</p>
        </div>
      </AuthCard>

      <PublicCard
        className="sm:p-9"
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
      </PublicCard>

      {mine.history.length > 1 ? (
        <PublicCard title="修改紀錄" className="sm:p-9">
          <ol className="flex flex-col gap-1.5 text-sm" aria-label="修改紀錄">
            {mine.history.map((h) => (
              <li key={h.revision} className="tabular-nums text-foreground">
                {formatWhen(h.at)}・{h.revision === 1 ? '送出' : '編輯'}
              </li>
            ))}
          </ol>
        </PublicCard>
      ) : null}

      <div className="flex justify-center">
        <SignOutButton className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground" />
      </div>
    </NarrowShell>
  )
}

/** 申請人看到的時間：`YYYY/M/D HH:mm`（臺灣時間；AC-VI-52）。 */
function formatWhen(iso: string): string {
  const p = taipeiParts(new Date(iso))
  return `${p.year}/${p.month}/${p.day} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}
