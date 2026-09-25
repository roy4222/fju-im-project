import { toCsvLine } from '@/shared/csv'
import { formatTaipeiSecond } from '@/shared/time'
import { ACCEPTANCE_NOTICE, describeCause, PURPOSE_LABEL, STATE_LABEL } from '@/application/signoff/version'
import type { AttachmentVersion, AuthorizationScope, Participants, SignoffPurpose, SignoffState } from '@/application/signoff/version'
import { VOTE_RESULT_LABEL, type VoteResult, type VoteRole } from '@/application/signoff/approval'

/**
 * 簽核版本的匯出（票 26／S11-09；產品模組 07 §4「同意紀錄內容與匯出（2026-09-12 定案）」；契約 03 §5）。
 *
 * - 可列印頁：全文、參與者、操作歷程（每筆同意／不同意／退回，以及重置、作廢、失效）、目前版本狀態，
 *   頁首標「站內內容確認與同意紀錄，行政採認待確認」。不做簽名 PDF。
 * - CSV 明細：一列一筆紀錄，每列都帶屆別、組別、用途、版本與 checksum、附件版本、授權範圍、應簽參與者集合，
 *   方便單獨一列拿出來也追得到。UTF-8 BOM、CRLF、每格經 `toCsvLine`（`= + - @ \t \r` 開頭加 `'`，Excel 不會當公式）。
 * - **不含** IP、瀏覽器資訊、token、密碼——資料來源本來就沒有這些欄。
 *
 * 這裡只有純函式：資料由 infrastructure 讀好傳進來，輸出字串。
 */

/** 一筆表態紀錄（`approvals` 一列）。 */
export type ExportVote = {
  readonly eventId: string
  readonly userId: string
  readonly displayNameAt: string
  readonly studentNoAt: string | null
  readonly role: VoteRole
  readonly loginMethod: 'google' | 'password'
  readonly buttonText: string
  readonly result: VoteResult
  readonly reason: string | null
  readonly realAt: Date
  readonly businessAt: Date
}

/** 版本本身的事件：建立、重置、重開、作廢、失效（稽核紀錄一列）。 */
export type ExportLifecycle = {
  readonly eventId: string | null
  readonly action: 'created' | 'reset' | 'reopened' | 'voided' | 'superseded'
  readonly actorUserId: string | null
  readonly actorName: string
  readonly reason: string | null
  readonly realAt: Date
  readonly businessAt: Date
}

export type SignoffExportData = {
  readonly cohortCode: string
  readonly groupCode: string
  readonly purpose: SignoffPurpose
  readonly versionId: string
  readonly versionNo: number
  readonly contentChecksum: string
  /** 已清洗過的全文 HTML。 */
  readonly contentHtml: string
  readonly attachments: readonly AttachmentVersion[]
  readonly authorizationScope: AuthorizationScope | null
  readonly participants: Participants
  readonly state: SignoffState
  readonly cause: string | null
  readonly isCurrent: boolean
  readonly votes: readonly ExportVote[]
  readonly lifecycle: readonly ExportLifecycle[]
  readonly exportedAt: Date
  readonly exportedByName: string
}

const LOGIN_LABEL = { google: 'Google', password: '密碼' } as const
const ROLE_LABEL: Record<VoteRole, string> = { student: '學生', advisor: '主指導' }
const LIFECYCLE_LABEL: Record<ExportLifecycle['action'], string> = {
  created: '建立版本',
  reset: '系辦重置',
  reopened: '系辦重開新版',
  voided: '作廢',
  superseded: '失效',
}

export function stateText(data: Pick<SignoffExportData, 'state' | 'cause'>): string {
  const cause = describeCause(data.cause)
  return data.state === 'superseded' || data.state === 'void' || data.state === 'revision'
    ? `${STATE_LABEL[data.state]}${cause ? `（${cause}）` : ''}`
    : STATE_LABEL[data.state]
}

function attachmentsText(attachments: readonly AttachmentVersion[]): string {
  return attachments.map((a) => `${a.name}［${a.source.itemTitle} 第 ${a.source.versionNo} 次送出］sha256:${a.checksum}`).join('；')
}

function scopeText(scope: AuthorizationScope | null): string {
  if (!scope) return ''
  const assets = scope.assets.map((a) => `${a.name} sha256:${a.checksum}`).join('、') || '無海報'
  return `用途：公開展示；題目：${scope.title}；摘要 sha256:${scope.summaryChecksum}；海報：${assets}；影片：${scope.videoUrl ?? '無'}`
}

function participantsText(p: Participants): string {
  return [...p.students.map((s) => `${s.displayName}${s.studentNo ? `(${s.studentNo})` : ''}`), `${p.advisor.displayName}(主指導)`].join('、')
}

export const CSV_HEADER = [
  '屆別',
  '組別',
  '簽核用途',
  '版本',
  '版本 ID',
  '內容 checksum',
  '附件版本',
  '授權範圍',
  '應簽參與者集合',
  '目前版本狀態',
  '紀錄類型',
  '事件 ID',
  '帳號 ID',
  '當時姓名',
  '學號',
  '角色',
  '這次登入方式',
  '按鈕原文',
  '結果',
  '理由',
  '真實時間（臺灣）',
  '業務時間（臺灣）',
] as const

/** CSV 明細全文（含 BOM、CRLF 行尾）。先列版本事件，再列每筆表態，各依時間排序。 */
export function buildSignoffCsv(data: SignoffExportData): string {
  const common = [
    data.cohortCode,
    data.groupCode,
    PURPOSE_LABEL[data.purpose],
    `v${data.versionNo}`,
    data.versionId,
    data.contentChecksum,
    attachmentsText(data.attachments),
    scopeText(data.authorizationScope),
    participantsText(data.participants),
    stateText(data),
  ]
  const lines = [toCsvLine([...CSV_HEADER])]
  for (const l of [...data.lifecycle].sort((a, b) => a.realAt.getTime() - b.realAt.getTime())) {
    lines.push(
      toCsvLine([
        ...common,
        LIFECYCLE_LABEL[l.action],
        l.eventId ?? '',
        l.actorUserId ?? '',
        l.actorName,
        '',
        '系辦',
        '',
        '',
        '',
        l.reason ?? '',
        formatTaipeiSecond(l.realAt),
        formatTaipeiSecond(l.businessAt),
      ]),
    )
  }
  for (const v of [...data.votes].sort((a, b) => a.realAt.getTime() - b.realAt.getTime())) {
    lines.push(
      toCsvLine([
        ...common,
        '表態',
        v.eventId,
        v.userId,
        v.displayNameAt,
        v.studentNoAt ?? '',
        ROLE_LABEL[v.role],
        LOGIN_LABEL[v.loginMethod],
        v.buttonText,
        VOTE_RESULT_LABEL[v.result],
        v.reason ?? '',
        formatTaipeiSecond(v.realAt),
        formatTaipeiSecond(v.businessAt),
      ]),
    )
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

function esc(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

/**
 * 可列印頁（獨立的 HTML 檔；路由另加 CSP 不跑任何腳本）。全文是伺服器端清洗過的受限 HTML，其他每一個欄位都逸出。
 */
export function buildSignoffPrintable(data: SignoffExportData): string {
  const title = `${data.groupCode}・${PURPOSE_LABEL[data.purpose]}・v${data.versionNo}`
  const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`
  const votesByUser = new Map(data.votes.map((v) => [v.userId, v]))
  const participantRows = [
    ...data.participants.students.map((s) => {
      const v = votesByUser.get(s.userId)
      return row([s.displayName, s.studentNo ?? '', '學生', v ? VOTE_RESULT_LABEL[v.result] : '尚未表態', v ? formatTaipeiSecond(v.realAt) : ''])
    }),
    (() => {
      const a = data.participants.advisor
      const v = votesByUser.get(a.userId)
      return row([a.displayName, '', '主指導', v ? VOTE_RESULT_LABEL[v.result] : '尚未表態', v ? formatTaipeiSecond(v.realAt) : ''])
    })(),
  ].join('')
  const history = [
    ...data.lifecycle.map((l) => ({
      at: l.realAt,
      cells: [formatTaipeiSecond(l.realAt), formatTaipeiSecond(l.businessAt), LIFECYCLE_LABEL[l.action], l.actorName, '', '', '', l.reason ?? '', l.eventId ?? ''],
    })),
    ...data.votes.map((v) => ({
      at: v.realAt,
      cells: [
        formatTaipeiSecond(v.realAt),
        formatTaipeiSecond(v.businessAt),
        VOTE_RESULT_LABEL[v.result],
        `${v.displayNameAt}${v.studentNoAt ? `（${v.studentNoAt}）` : ''}`,
        ROLE_LABEL[v.role],
        LOGIN_LABEL[v.loginMethod],
        v.buttonText,
        v.reason ?? '',
        v.eventId,
      ],
    })),
  ]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((h) => row(h.cells))
    .join('')
  const scope = data.authorizationScope
  const scopeHtml = scope
    ? `<h2>授權範圍</h2><dl><dt>用途</dt><dd>公開展示（優秀專題）</dd><dt>題目</dt><dd>${esc(scope.title)}</dd><dt>摘要</dt><dd style="white-space:pre-line">${esc(
        scope.summary,
      )}</dd><dt>海報</dt><dd>${esc(scope.assets.map((a) => `${a.name}（sha256:${a.checksum}）`).join('、') || '沒有海報')}</dd><dt>影片連結</dt><dd>${esc(
        scope.videoUrl ?? '沒有影片連結',
      )}</dd></dl>`
    : ''
  const attachments =
    data.attachments.length === 0
      ? '<p>這一版沒有附件。</p>'
      : `<ul>${data.attachments
          .map((a) => `<li>${esc(a.name)}（${esc(a.source.itemTitle)} 第 ${a.source.versionNo} 次正式送出；sha256:${esc(a.checksum)}）</li>`)
          .join('')}</ul>`
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;color:#111;max-width:52rem;margin:2rem auto;padding:0 1rem;line-height:1.7}
h1{font-size:1.25rem;margin:0}h2{font-size:1rem;margin-top:1.5rem;border-bottom:1px solid #ccc}
.notice{border:1px solid #999;padding:.5rem .75rem;font-size:.85rem}
table{border-collapse:collapse;width:100%;font-size:.8rem}td,th{border:1px solid #bbb;padding:.25rem .4rem;text-align:left;vertical-align:top}
dl{display:grid;grid-template-columns:6rem 1fr;gap:.25rem 1rem}dt{color:#555}.meta{font-size:.8rem;color:#444}
@media print{body{margin:0}}
</style></head><body>
<p class="notice">${esc(ACCEPTANCE_NOTICE)}</p>
<h1>${esc(title)}</h1>
<p class="meta">${esc(data.cohortCode)}・版本 ID ${esc(data.versionId)}・內容 checksum（sha256）${esc(data.contentChecksum)}<br>
目前版本狀態：<strong>${esc(stateText(data))}</strong>${data.isCurrent ? '' : '（已不是目前版本）'}<br>
匯出：${esc(data.exportedByName)}・${esc(formatTaipeiSecond(data.exportedAt))}</p>
<h2>全文</h2>
<div>${data.contentHtml}</div>
<h2>附件</h2>
${attachments}
${scopeHtml}
<h2>參與者（應簽 ${data.participants.students.length} 位學生＋主指導）</h2>
<table><thead><tr><th>姓名</th><th>學號</th><th>角色</th><th>結果</th><th>時間</th></tr></thead><tbody>${participantRows}</tbody></table>
<h2>操作歷程</h2>
<table><thead><tr><th>真實時間</th><th>業務時間</th><th>動作</th><th>操作者</th><th>角色</th><th>登入方式</th><th>按鈕原文</th><th>理由</th><th>事件 ID</th></tr></thead><tbody>${
    history || '<tr><td colspan="9">還沒有任何紀錄。</td></tr>'
  }</tbody></table>
<p class="meta">系統證明的是站內內容確認與同意紀錄，不代表已證明使用者完整閱讀，也不代表校方已核可。</p>
</body></html>
`
}
