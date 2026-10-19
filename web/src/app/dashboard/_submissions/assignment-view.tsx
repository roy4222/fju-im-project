import Link from 'next/link'
import { IconArrowLeft, IconPaperclip, IconPencil, IconUser, IconUsers, IconUsersGroup } from '@tabler/icons-react'
import { DEFAULT_FILE_RULES, limitText } from '@/app/dashboard/_submissions/file-size-guard'
import { ChecksumDisclosure, ReceiptNoDisclosure } from '@/app/dashboard/_submissions/proof-disclosure'
import { HistoryTable } from '@/app/dashboard/student/affairs/[id]/history-table'
import { SubmissionForm } from '@/app/dashboard/student/affairs/[id]/submission-form'
import { BANNER_CLASS } from '@/app/dashboard/student/affairs/tone'
import type { FileMeta } from '@/app/dashboard/student/affairs/types'
import type { FormField } from '@/application/items'
import type { GroupSummary, MyItemDetail, MyVersionDetail } from '@/application/submissions'
import { renderBodyHtml } from '@/composition/items'
import { answerFields, getSubmissionQuery, isFileField, phaseOf, statusOf } from '@/composition/submissions'
import { cn } from '@/shared/cn'
import { formatBytes } from '@/shared/format-bytes'
import { formatTaipeiMinute, formatTaipeiSecond } from '@/shared/time'

/**
 * 交作業的作業頁主體（C 階段規格① §5.2、§5.3）：學生「交作業」與名單上老師「作業區 › 我的作業」共用同一套畫面，
 * 外殼（側欄、角色）由各自的 `page.tsx` 包；授權在用例（`authorizeReceiver`，C1-02），這裡不判角色。
 *
 * 分頁「作業內容｜繳交歷史」：
 * - 作業內容：截止、開放、作業說明、附件、繳交欄位的唯讀說明。
 * - 繳交歷史：頂部「寫作業」（截止且沒補交權 → disabled「已截止」）＋檔案上限提示（由欄位 `fileRules` 產生）；
 *   按「寫作業」（`?tab=history&write=1`）在同頁打開表單區；下面是正式送出的版本表（沒有草稿列）。
 *   `&version=N` 看那一次的內容（唯讀）。
 */
export async function AssignmentView({
  base,
  listLabel,
  userId,
  item,
  businessNow,
  tab,
  versionNo,
  write,
}: {
  /** 清單網址：`/dashboard/student/affairs` 或 `/dashboard/teacher/affairs`。 */
  base: string
  /** 返回連結的字（「交作業」「作業區」）。 */
  listLabel: string
  userId: string
  item: MyItemDetail
  businessNow: Date
  tab: 'content' | 'history'
  versionNo: number
  write: boolean
}) {
  const href = `${base}/${item.itemId}`
  const historyHref = `${href}?tab=history`
  const writeHref = `${historyHref}&write=1`
  const version =
    tab === 'history' && Number.isInteger(versionNo) && versionNo > 0 ? await getSubmissionQuery().myVersion(userId, item.itemId, versionNo) : null

  // 個別補交（W10）：已截止、但系辦替自己（整組：自己這一組）開了還沒到期的補交期限，就照開放算。
  const window = { opensAt: item.opensAt, dueAt: item.dueAt }
  const phase = phaseOf(window, businessNow, item.reopenUntil)
  const reopenUntil = phase === 'open' && phaseOf(window, businessNow) === 'closed' ? item.reopenUntil : null
  const latest = item.versions[0] ?? null
  const status = statusOf({
    phase,
    opensAt: item.opensAt,
    latestVersionNo: latest?.versionNo ?? null,
    // 草稿是隱形的（§5.2）：上傳過檔案也還是「未繳」，橫幅不寫「草稿已存」。
    hasDraft: false,
    exempt: item.exempt,
    reopenUntil,
  })
  const reopenText = reopenUntil ? `系辦已開放${item.receiverUnit === 'group' ? '你們這一組' : '你'}補交到 ${formatTaipeiMinute(reopenUntil)}（臺灣時間，含此分鐘）` : null
  // 學生頁不寫「請聯絡系辦」、免繳不寫長句（Q69、Q127）：逾期只寫「已截止」，免繳只寫「免繳」。
  const detail = item.exempt ? '免繳' : status.overdue ? '已截止' : status.detail
  const banner = reopenText
    ? latest
      ? `${reopenText}・已繳第 ${latest.versionNo} 次，期限前可重送`
      : reopenText
    : latest
      ? `已繳第 ${latest.versionNo} 次・${latest.submittedByName} 於 ${formatTaipeiSecond(latest.receivedBusinessAt)} 送出・${detail}`
      : item.exempt
        ? '免繳'
        : `${status.headline}・${detail}`
  // 不能寫的原因：免繳、尚未開放、已截止（逾期多一句「可向系辦申請補交」，不帶聯絡方式，Q127）。
  const locked = item.exempt
    ? { button: '免繳', note: null }
    : phase === 'not_open'
      ? { button: '尚未開放', note: `${item.opensAt ? formatTaipeiMinute(item.opensAt) : ''}（臺灣時間）開放後才能寫作業。` }
      : phase === 'closed'
        ? { button: '已截止', note: status.overdue ? '可向系辦申請補交' : null }
        : null
  const editable = status.editable && locked === null
  const fileFields = item.fields.filter((f) => f.type === 'file')
  const limits = [...new Set(fileFields.map((f) => limitText(f.fileRules ?? DEFAULT_FILE_RULES)))]
  // 橫幅顏色照原型：已繳綠、逾期紅、還沒動的待繳用藍色提示。
  const bannerTone = reopenText || (status.pending && status.tone === 'muted') ? 'info' : status.tone
  const group = item.group

  const info: [string, string][] = [
    ['截止時間', item.dueAt ? `${formatTaipeiMinute(item.dueAt)}（含此分鐘）` : '無'],
    ['開放時間', item.opensAt ? formatTaipeiMinute(item.opensAt) : '發布即開放'],
    ...(reopenUntil ? [['補交期限', `${formatTaipeiMinute(reopenUntil)}（含此分鐘）`] as [string, string]] : []),
    ['重送', phase === 'closed' ? '截止後唯讀' : reopenUntil ? '補交期限前可重送，以最後一次為準' : '截止前可重送，以最後一次為準'],
  ]

  const writeButton = editable ? (
    <Link href={writeHref} className="btn-fju h-11 gap-1.5 rounded-lg px-5 text-sm" data-testid="write-button">
      <IconPencil className="size-4" aria-hidden /> 寫作業
    </Link>
  ) : locked ? (
    <button type="button" disabled className="btn-fju h-11 rounded-lg px-5 text-sm opacity-50" data-testid="write-button">
      {locked.button}
    </button>
  ) : null

  return (
    <div className="flex flex-col gap-5">
      <BackLink href={base} label={listLabel} />
      <article className="dash-card overflow-hidden">
        <header className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5 pb-3">
          <div className="min-w-0">
            <h1 className="text-[22px] font-extrabold tracking-tight">{item.title}</h1>
            <p className="mt-1 flex items-start gap-1.5 text-[13px] text-muted-foreground">
              <UnitIcon group={Boolean(group)} />
              <span className="tabular">{group ? '整組一份・任一位組員繳交就代表全組' : '個人一份・各自繳交'}</span>
            </p>
          </div>
          {tab === 'content' ? writeButton : null}
        </header>
        <p className={cn('mx-6 mb-4 rounded-lg px-4 py-3 text-sm font-semibold', BANNER_CLASS[bannerTone])} data-testid="affair-banner">
          {banner}
        </p>
        <nav className="flex gap-1 border-b border-border px-4" aria-label="作業分頁">
          {(
            [
              ['content', '作業內容', href],
              ['history', `繳交歷史${item.versions.length ? `（${item.versions.length}）` : ''}`, historyHref],
            ] as const
          ).map(([key, label, to]) => (
            <Link
              key={key}
              href={to}
              aria-current={tab === key ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex h-11 items-center border-b-2 px-4 text-sm font-semibold transition-colors',
                tab === key ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </Link>
          ))}
        </nav>

        {tab === 'content' ? (
          <div className="flex flex-col gap-6 p-6">
            <dl className="grid gap-x-8 gap-y-2 border-b border-border pb-4 text-sm sm:grid-cols-2">
              {info.map(([k, v]) => (
                <div key={k} className="flex gap-4">
                  <dt className="w-16 shrink-0 text-muted-foreground">{k}</dt>
                  <dd className="tabular font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
            <section aria-labelledby="sec-brief">
              <h2 id="sec-brief" className="mb-2 text-[15px] font-bold">
                作業說明
              </h2>
              {item.summary ? <p className="mb-2 text-sm leading-7">{item.summary}</p> : null}
              {item.bodyHtml ? (
                <div className="prose-item space-y-2 text-sm leading-7" dangerouslySetInnerHTML={{ __html: renderBodyHtml(item.bodyHtml) }} />
              ) : null}
              {item.attachments.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1.5" aria-label="附件">
                  {item.attachments.map((file) => (
                    <li key={file.fileId}>
                      <a
                        href={`/api/files/${file.fileId}`}
                        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-ink transition-colors hover:text-brand"
                      >
                        <IconPaperclip className="size-4" aria-hidden />
                        {file.name}
                      </a>
                      <span className="ml-2 text-xs text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
            <FieldsBrief fields={item.fields} />
          </div>
        ) : (
          <div className="flex flex-col gap-5 p-6">
            {version ? (
              <VersionView historyHref={historyHref} version={version} />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="history-toolbar">
                  {writeButton}
                  {limits.length > 0 ? (
                    <span className="text-sm text-muted-foreground" data-testid="file-limit">
                      檔案上限：{limits.join('；')}
                    </span>
                  ) : null}
                  {locked?.note ? <span className="basis-full text-sm text-muted-foreground">{locked.note}</span> : null}
                </div>
                {write && editable ? (
                  <section aria-labelledby="sec-write" className="rounded-xl border border-border p-5" data-testid="write-panel">
                    <h2 id="sec-write" className="mb-3 text-[15px] font-bold">
                      寫作業
                    </h2>
                    {group ? <GroupBar group={group} /> : null}
                    {item.advisorCanView ? (
                      <p className="mb-3 rounded-lg bg-muted px-4 py-2.5 text-sm text-ink" data-testid="advisor-notice">
                        你的指導老師可以查看這一項<strong>正式送出</strong>的回答（還沒繳交的不會給老師看）。
                      </p>
                    ) : null}
                    <WriteForm item={item} base={base} historyHref={historyHref} />
                  </section>
                ) : null}
                <HistoryTable versions={item.versions} hrefOf={(no) => `${historyHref}&version=${no}`} />
              </>
            )}
          </div>
        )}
      </article>
    </div>
  )
}

/** 「寫作業」表單的初值：草稿裡**只帶檔案欄**（標「上次選的檔案」），文字欄是空的（§5.2）。 */
function WriteForm({ item, base, historyHref }: { item: MyItemDetail; base: string; historyHref: string }) {
  const draft = item.draft
  const answers: Record<string, string> = {}
  const files: Record<string, FileMeta> = {}
  for (const field of item.fields) {
    if (field.type !== 'file') continue
    const value = draft?.answers[field.key]
    const file = typeof value === 'string' ? draft?.files.find((f) => f.fileId === value) : undefined
    if (!file) continue
    answers[field.key] = file.fileId
    files[file.fileId] = { name: file.name, sizeBytes: file.sizeBytes }
  }
  return (
    <SubmissionForm
      itemId={item.itemId}
      fields={item.fields}
      initialAnswers={answers}
      initialFiles={files}
      initialRevision={draft?.revision ?? 0}
      carriedOver={Object.keys(answers)}
      listHref={base}
      historyHref={historyHref}
    />
  )
}

/** 作業內容頁的「繳交欄位」：要交哪些欄、哪些必填、檔案的類型與上限（唯讀說明，不能填）。 */
function FieldsBrief({ fields }: { fields: readonly FormField[] }) {
  const inputs = answerFields(fields)
  if (inputs.length === 0) return null
  return (
    <section aria-labelledby="sec-fields">
      <h2 id="sec-fields" className="mb-2 text-[15px] font-bold">
        繳交欄位
      </h2>
      <ul className="flex flex-col divide-y divide-border/70 rounded-lg border border-border text-sm" data-testid="fields-brief">
        {inputs.map((f) => (
          <li key={f.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <span className="font-semibold">{f.label}</span>
            {f.required ? <span className="text-xs text-destructive">必填</span> : <span className="text-xs text-muted-foreground">選填</span>}
            {isFileField(f) ? (
              <span className="text-xs text-muted-foreground">檔案・{limitText(f.fileRules ?? DEFAULT_FILE_RULES)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 回清單（原型：左箭頭＋灰字）。 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
    >
      <IconArrowLeft className="size-4" aria-hidden /> {label}
    </Link>
  )
}

/** 填寫單位的小圖示：整組一份／個人一份。 */
export function UnitIcon({ group }: { group: boolean }) {
  const Icon = group ? IconUsersGroup : IconUser
  return <Icon className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden />
}

/** 組別資訊列（原型 `groupinfo`）：組別代號、組長、組員、指導老師。 */
function GroupBar({ group }: { group: GroupSummary }) {
  const leader = group.members.find((m) => m.isLeader)
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border pb-3 text-sm" data-testid="group-bar">
      <span className="inline-flex items-center gap-1.5 font-bold">
        <IconUsers className="size-4 text-ink" aria-hidden />
        {group.code}
      </span>
      {leader ? <span>組長 {leader.name}</span> : null}
      <span className="text-muted-foreground">{group.members.map((m) => m.name).join('、')}</span>
      <span className="text-muted-foreground">指導老師 {group.advisorName ?? '尚未指派'}</span>
    </div>
  )
}

/** 截止後靠系辦開的個別補交送出的版本（W10）。 */
function LateBadge() {
  return (
    <span className="ml-2 rounded-full bg-warning-subtle px-2 py-0.5 text-[11px] text-warning-on-subtle" data-testid="late-badge">
      補交
    </span>
  )
}

/** 某一次繳交的內容（唯讀）。 */
function VersionView({ historyHref, version }: { historyHref: string; version: MyVersionDetail }) {
  const fields = answerFields(version.fields)
  return (
    <div className="flex flex-col gap-5" data-testid="version-view">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link
          href={historyHref}
          className="inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconArrowLeft className="size-4" aria-hidden /> 繳交歷史
        </Link>
        <span className="text-xs text-muted-foreground">唯讀・這是那一次繳交當時的內容</span>
      </div>
      <dl className="grid gap-x-8 gap-y-2 border-y border-border py-3 text-sm sm:grid-cols-2">
        <div className="flex gap-4">
          <dt className="w-16 shrink-0 text-muted-foreground">繳交人</dt>
          <dd className="font-semibold">{version.submittedByName}</dd>
        </div>
        <div className="flex gap-4">
          <dt className="w-16 shrink-0 text-muted-foreground">已交時間</dt>
          <dd className="font-semibold tabular-nums">
            {formatTaipeiSecond(version.receivedBusinessAt)}
            {version.isLatest ? null : <span className="ml-2 text-xs font-normal text-muted-foreground">已被後來的繳交取代</span>}
            {version.late ? <LateBadge /> : null}
          </dd>
        </div>
        <ReceiptNoDisclosure requestId={version.requestId} className="sm:col-span-2" />
      </dl>
      <dl className="flex flex-col divide-y divide-border/70">
        {fields.map((f) => {
          const value = version.answers[f.key]
          const file = isFileField(f) ? version.files.find((x) => x.fieldKey === f.key) : undefined
          const text = value === undefined || isFileField(f) ? '' : typeof value === 'string' ? value : value.join('、')
          return (
            <div key={f.key} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-6">
              <dt className="text-sm font-semibold">{f.label}</dt>
              <dd className="whitespace-pre-wrap text-sm">
                {file ? (
                  <span className="flex flex-wrap items-center gap-x-3">
                    <a href={`/api/files/${file.fileId}`} className="inline-flex items-center gap-1.5 break-all font-semibold text-ink underline-offset-2 hover:underline">
                      {file.name}
                    </a>
                    <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(file.sizeBytes)}</span>
                    <ChecksumDisclosure checksum={file.checksum} className="basis-full" />
                  </span>
                ) : (
                  text || <span className="text-muted-foreground">（未填）</span>
                )}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}
