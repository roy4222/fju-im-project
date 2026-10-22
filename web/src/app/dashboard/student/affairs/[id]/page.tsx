import { notFound } from 'next/navigation'
import { requireRole } from '@/app/_ui/guard'
import { GoneNotice } from '@/app/_ui/public-content'
import { DashboardShell } from '@/app/_ui/site-shell'
import { STUDENT_NAV } from '@/app/dashboard/_nav'
import { AssignmentView, BackLink, UnitIcon } from '@/app/dashboard/_submissions/assignment-view'
import { VersionContent, VersionTable } from '@/app/dashboard/_submissions/version-parts'
import { ConsentStatus } from '@/app/dashboard/student/affairs/[id]/consent-status'
import { getBusinessClock } from '@/composition/cohorts'
import { getSignoffQuery } from '@/composition/signoff'
import { getSubmissionQuery } from '@/composition/submissions'

export const metadata = { title: '作業內容｜資管系專題平台', robots: { index: false } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 學生作業頁（C 階段規格① §5.2）：「作業內容｜繳交歷史」兩個分頁、「寫作業」（`?tab=history&write=1`）在同頁開表單。
 * 畫面本體是 `AssignmentView`，名單上的老師（`/dashboard/teacher/affairs/[id]`）用同一套。
 *
 * 只有自己（整組一份：自己此刻所在的組）在目前收件名單上才看得到（不在名單上一律 404，不透露這份收件存在）。
 * 系辦刪掉的作業：本人原本看得到才顯示「這份作業已刪除」（200，CL-14），其他人照舊 404。
 * `?record=<收件者>` 是「以前的紀錄」（票 22）：已經不在作業區、本人讀得到的正式版本，唯讀。
 * 站內同意書（自己這組連到這份作業的簽核包）改成「說明｜狀態」兩個分頁（`?tab=about`／`?tab=status`，C1-11、§6.2）。
 */
export default async function StudentAffairPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string | string[]; version?: string | string[]; record?: string | string[]; write?: string | string[] }>
}) {
  const { id } = await params
  const actor = await requireRole(`/dashboard/student/affairs${UUID.test(id) ? `/${id}` : ''}`, 'student')
  if (!UUID.test(id)) notFound()
  const userId = actor.kind === 'authenticated' ? actor.userId : ''
  const search = await searchParams
  const tab = search.tab === 'history' ? 'history' : 'content'
  const versionNo = Number(typeof search.version === 'string' ? search.version : NaN)

  const query = getSubmissionQuery()

  // 我的繳交紀錄（票 22）：已經不在作業區、本人讀得到的正式版本（`?record=<收件者>`）。唯讀；一版都讀不到就 404。
  const record = typeof search.record === 'string' ? search.record : undefined
  if (record !== undefined) {
    if (!UUID.test(record)) notFound()
    const detail = await query.myRecord(userId, id, record)
    if (!detail) notFound()
    const recordBase = `/dashboard/student/affairs/${id}?record=${record}`
    const shown = typeof search.version === 'string' ? await query.myRecordVersion(userId, id, record, versionNo) : null
    if (typeof search.version === 'string' && !shown) notFound()
    return (
      <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/affairs">
        <div className="flex flex-col gap-5">
          <BackLink href="/dashboard/student/affairs" label="交作業" />
          <article className="dash-card overflow-hidden" data-testid="record-view">
            <header className="px-6 pt-5 pb-3">
              <h1 className="text-[22px] font-extrabold tracking-tight">{detail.title}</h1>
              <p className="mt-1 flex items-start gap-1.5 text-[13px] text-muted-foreground">
                {detail.receiverKind === 'group' ? <UnitIcon group /> : <UnitIcon group={false} />}
                <span className="tabular">
                  {detail.receiverKind === 'group' ? `整組一份（${detail.groupCode ?? ''}）` : '個人一份'}・我的繳交紀錄（唯讀）
                </span>
              </p>
            </header>
            <p className="mx-6 mb-4 rounded-lg bg-muted px-4 py-3 text-sm font-semibold text-ink" data-testid="record-banner">
              {detail.receiverKind === 'group'
                ? '你已經不在這一組：只看得到你還在組裡時送出的版本與附件，不能再填寫或送出。'
                : '你已經不在這一項的繳交名單上：只看得到自己正式送出過的回答，不能再填寫或送出。'}
            </p>
            <div className="border-t border-border p-6">
              {shown ? (
                <VersionContent version={shown} backHref={recordBase} backLabel="繳交紀錄" />
              ) : (
                <VersionTable versions={detail.versions} hrefOf={(no) => `${recordBase}&version=${no}`} label="繳交紀錄" />
              )}
            </div>
          </article>
        </div>
      </DashboardShell>
    )
  }

  const [item, businessNow, consent] = await Promise.all([
    query.myItem(userId, id),
    getBusinessClock().now(),
    getSignoffQuery().studentViewByItem(actor, id),
  ])
  const consentVersion = consent.versions[0]
  // 已刪除、本人原本看得到（CL-14）：舊通知、催繳信、書籤點進來給友善頁；同意書作業刪了也一樣（不再顯示同意書狀態）。
  // 只在打不開或是同意書時多查這一句；看不到的人照舊 404。
  if ((!item || consentVersion) && (await query.deletedItemSeenBy(userId, id))) {
    return (
      <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/affairs">
        <GoneNotice kind="deleted" what="作業" unit="份" back={{ href: '/dashboard/student/affairs', label: '回到交作業' }} />
      </DashboardShell>
    )
  }
  if (consentVersion) {
    return (
      <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/affairs">
        <ConsentStatus
          v={consentVersion}
          tab={search.tab === 'status' ? 'status' : 'about'}
          href={`/dashboard/student/affairs/${id}`}
          back={{ href: '/dashboard/student/affairs', label: '交作業' }}
        />
      </DashboardShell>
    )
  }
  if (!item) notFound()

  return (
    <DashboardShell roleLabel="學生" items={STUDENT_NAV} current="/dashboard/student/affairs">
      <AssignmentView
        base="/dashboard/student/affairs"
        listLabel="交作業"
        userId={userId}
        item={item}
        businessNow={businessNow}
        tab={tab}
        versionNo={versionNo}
        write={search.write === '1'}
      />
    </DashboardShell>
  )
}

