import Link from 'next/link'
import { requireRole } from '@/app/_ui/guard'
import { PageTitle, pillClass } from '@/app/_ui/dashboard-kit'
import { EmptyState, LinkButton } from '@/app/_ui/primitives'
import { DashboardShell } from '@/app/_ui/site-shell'
import { ADMIN_NAV } from '@/app/dashboard/_nav'
import { AffairsList, type AffairRow } from '@/app/dashboard/admin/affairs/affairs-list'
import { AFFAIRS_FILTERS, affairsView } from '@/app/dashboard/admin/affairs/affairs-view'
import { QuickCreateDialog } from '@/app/dashboard/admin/affairs/quick-create-dialog'
import { editorVocabulary } from '@/app/dashboard/admin/affairs/vocabulary'
import { COHORT_STATUS_LABEL, cohortLabel, getBusinessClock, getCohortStatusQuery } from '@/composition/cohorts'
import {
  AUDIENCE_LABEL,
  collectsResponses,
  getItemQuery,
  ITEM_STATUS_LABEL,
  PLACEMENT_LABEL,
  RECEIVER_UNIT_LABEL,
} from '@/composition/items'
import { formatTaipeiDate, formatTaipeiMinute, isDeadlinePassed, taipeiDateOf } from '@/shared/time'

export const metadata = { title: '專題事務｜資管系專題平台' }

const FILTERS = AFFAIRS_FILTERS

/**
 * 專題事務工作台（票 15；原型 `/dashboard/admin/affairs`）。
 *
 * 公告、資源、文件繳交全部從這裡建立：日常用「新增項目」三步驟，要細調欄位、附件、封面再進完整編輯器
 * （同一個項目 ID）。編輯器不另放側欄入口（產品模組 04「單一入口」）。
 * 撤回、下架、重新發布在完整編輯器的頂列（票 16）；收件進度與名單頁在票 18。
 *
 * 榮譽是跨屆的公開紀錄（第三波 W1／W1b）：選「榮譽」篩選時，屆別選單連已封存的屆別也列出來，
 * 系辦才點得到歷屆（例如示範資料 DEMO-113、DEMO-112）的榮譽並進編輯器；頁首多一顆「新增榮譽」，帶目前選的屆別。
 * 封存屆別只能動榮譽，所以那時不放「新增項目」與一般的完整編輯器入口。屆別全部封存時，一般篩選改成說明＋
 * 「管理歷屆榮譽」入口（不是「還沒有屆別」的死路）。
 */
export default async function AffairsPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string | string[]; placement?: string | string[] }>
}) {
  await requireRole('/dashboard/admin/affairs', 'admin')

  const view = affairsView(await getCohortStatusQuery().list(), await searchParams)
  const filter = view.filter
  const honorView = filter === 'honor'

  const shell = (description: string, children: React.ReactNode, actions?: React.ReactNode) => (
    <DashboardShell roleLabel="系辦" items={ADMIN_NAV} current="/dashboard/admin/affairs">
      <div className="flex flex-col gap-5">
        <PageTitle title="專題事務" description={description} actions={actions} />
        {children}
      </div>
    </DashboardShell>
  )

  if (view.state === 'only-archived') {
    return shell(
      '目前沒有進行中的屆別；歷屆榮譽仍可在這裡管理。',
      <EmptyState
        title="屆別都已封存"
        description="封存的屆別不能再新增公告、資源或繳交項目；榮譽是跨屆的公開紀錄，仍可新增、編輯、下架或刪除。要開始新的一屆請到屆別頁。"
        action={{ href: '/dashboard/admin/affairs?placement=honor', label: '管理歷屆榮譽' }}
      />,
    )
  }

  if (view.state === 'none') {
    return shell(
      '公告、資源下載、文件繳交都從這裡建立、發布與修改。',
      <EmptyState
        title="還沒有屆別"
        description="專題事務要綁在某一屆；先到屆別頁新增一屆。"
        action={{ href: '/dashboard/admin/cohorts', label: '前往屆別' }}
      />,
    )
  }

  const { cohorts, cohort } = view
  const [rows, vocabulary, businessNow] = await Promise.all([
    getItemQuery().list(cohort.id),
    editorVocabulary(cohort.id),
    getBusinessClock().now(),
  ])
  const shown = rows.filter((r) => filter === 'all' || r.placement === filter)
  // 封存屆別只會在榮譽篩選下出現；那時只能動榮譽。
  const archived = cohort.status === 'archived'
  const published = rows.filter((r) => r.status === 'published').length
  const collecting = rows.filter((r) => collectsResponses(r.placement) && r.status === 'published').length
  const query = (patch: Record<string, string>) => {
    const next = new URLSearchParams({ cohort: cohort.id, ...(filter !== 'all' ? { placement: filter } : {}), ...patch })
    if (next.get('placement') === 'all') next.delete('placement')
    return `/dashboard/admin/affairs?${next.toString()}`
  }

  const list: AffairRow[] = shown.map((r) => {
    const collects = collectsResponses(r.placement)
    return {
      id: r.id,
      kind: PLACEMENT_LABEL[r.placement],
      title: r.title,
      status: r.status,
      statusLabel: ITEM_STATUS_LABEL[r.status],
      visibility: r.audienceKind === 'public' ? '網際網路公開' : '登入後可見',
      audience:
        r.audienceKind === 'groups' ? `指定組別：${r.audienceGroupCodes.join('、') || '（還沒選）'}` : AUDIENCE_LABEL[r.audienceKind],
      // 原型這一欄只寫日期；截止多寫到分鐘（23:59 截止跟 00:00 截止差一天）。
      date: r.dueAt ? formatTaipeiMinute(r.dueAt) : r.actualOpenedAt ? formatTaipeiDate(taipeiDateOf(r.actualOpenedAt)) : '—',
      isDue: r.dueAt !== null,
      // 截止含當分鐘（Vault 04 §4）：跟收件判定用同一個 helper。
      overdue: r.dueAt !== null && isDeadlinePassed(businessNow, r.dueAt),
      // 收件名單頁（票 18）：數字＝應交數（不含免填），跟名單頁完成率的分母同一個口徑。
      roster: collects
        ? r.status === 'draft'
          ? { text: RECEIVER_UNIT_LABEL[r.receiverUnit], href: null }
          : {
              text: `需要繳交 ${r.rosterCount} ${r.receiverUnit === 'group' ? '組' : '位'}`,
              href: `/dashboard/admin/affairs/${r.id}`,
            }
        : null,
      // 前台頁面：發布中的公告才有自己的內容頁（資源、規則是整頁列表）；發布中的榮譽連到前台榮譽榜。
      publicHref:
        r.status !== 'published' ? null : r.placement === 'news' ? `/news/${r.id}` : r.placement === 'honor' ? '/honors' : null,
      editHref: `/dashboard/admin/editor/${r.id}`,
    }
  })

  return shell(
    `${cohortLabel(cohort)}・${COHORT_STATUS_LABEL[cohort.status]}・${rows.length} 項・發布中 ${published}・開放繳交中 ${collecting}`,
    <>
      {cohorts.length > 1 ? (
        <nav aria-label="選擇屆別" className="flex flex-wrap gap-1.5">
          {cohorts.map((c) => (
            <Link
              key={c.id}
              // 榮譽篩選下換屆別仍停在榮譽（才看得到封存屆別）；其他篩選照舊回到全部。
              href={honorView ? query({ cohort: c.id }) : `/dashboard/admin/affairs?cohort=${c.id}`}
              aria-current={c.id === cohort.id ? 'page' : undefined}
              className={pillClass(c.id === cohort.id)}
            >
              {c.code}
              {c.status === 'archived' ? <span className="ml-1 text-xs font-normal opacity-80">（已封存）</span> : null}
            </Link>
          ))}
        </nav>
      ) : null}
      {honorView ? (
        <p className="text-sm text-muted-foreground" data-testid="honor-list-hint">
          榮譽是跨屆的公開紀錄：上方屆別含已封存的屆別，選那一屆就看得到歷屆榮譽，可以編輯、下架、重新發布或刪除。發布中的會出現在前台
          <Link href="/honors" className="mx-0.5 font-semibold text-foreground underline underline-offset-2">
            「榮譽榜」
          </Link>
          。
        </p>
      ) : null}

      <AffairsList
        rows={list}
        filters={FILTERS.map((f) => ({ key: f.key, label: f.label, href: query({ placement: f.key }), active: filter === f.key }))}
        emptyText={
          filter === 'all'
            ? '這一屆還沒有任何專題事務。按「新增項目」建立第一筆。'
            : honorView
              ? '這一屆還沒有榮譽。按「新增榮譽」建立第一則。'
              : '這個種類還沒有項目。'
        }
      />
    </>,
    <>
      {honorView ? (
        <LinkButton href={`/dashboard/admin/editor/new?cohort=${cohort.id}&placement=honor`} variant={archived ? 'primary' : 'secondary'}>
          新增榮譽
        </LinkButton>
      ) : null}
      {archived ? null : (
        <>
          <LinkButton href={`/dashboard/admin/editor/new?cohort=${cohort.id}`} variant="secondary">
            用完整編輯器建立
          </LinkButton>
          <QuickCreateDialog cohortId={cohort.id} vocabulary={vocabulary} />
        </>
      )}
    </>,
  )
}
