import { describe, expect, it } from 'vitest'
import {
  canViewItem,
  describeDeadline,
  describeFailedChecks,
  EMPTY_COLLECTION_MESSAGE,
  failedChecks,
  normalizeItemInput,
  normalizeSchema,
  publishChecks,
  renderBodyHtml,
  sanitizeBody,
  snapshotDueAt,
  type ItemInput,
  type PublishState,
  type Viewer,
} from '@/application/items'

const COHORT = '11111111-1111-4111-8111-111111111111'
const STAGE = '22222222-2222-4222-8222-222222222222'
const G1 = '33333333-3333-4333-8333-333333333333'
const G2 = '44444444-4444-4444-8444-444444444444'
const FILE = '55555555-5555-4555-8555-555555555555'

const input = (patch: Partial<ItemInput> = {}): ItemInput => ({
  cohortId: COHORT,
  placement: 'submission',
  title: '期中報告',
  summary: '',
  body: '',
  category: '',
  coverFileId: null,
  attachmentFileIds: [],
  audienceKind: 'cohort_students',
  groupIds: [],
  receiverUnit: 'group',
  stageId: STAGE,
  opensAt: '',
  dueAt: '2026-11-15T23:59',
  fields: [{ key: 'report', type: 'file', label: '報告', required: true }],
  ...patch,
})

describe('normalizeItemInput：位置、對象、收件單位', () => {
  it('收件只能發給本屆學生或指定組別', () => {
    for (const audienceKind of ['public', 'signed_in', 'teachers']) {
      const result = normalizeItemInput(input({ audienceKind }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain('本屆學生')
    }
    expect(normalizeItemInput(input({ audienceKind: 'groups', groupIds: [G1] })).ok).toBe(true)
  })

  it('文件繳交一定要選收件單位；公告與資源一律不收件', () => {
    expect(normalizeItemInput(input({ receiverUnit: 'none' })).ok).toBe(false)
    const news = normalizeItemInput(input({ placement: 'news', audienceKind: 'public', receiverUnit: 'group' }))
    expect(news.ok && news.value.receiverUnit).toBe('none')
    // 公告不留收件欄位、截止、階段。
    expect(news.ok && news.value.fields).toEqual([])
    expect(news.ok && news.value.dueAt).toBeNull()
    expect(news.ok && news.value.stageId).toBeNull()
  })

  it('開放公告、資源、文件繳交（票 15）與專題規則（票 16）；其餘位置還不能建', () => {
    expect(normalizeItemInput(input({ placement: 'showcase' })).ok).toBe(false)
    expect(normalizeItemInput(input({ placement: 'requirement' })).ok).toBe(false)
    expect(normalizeItemInput(input({ placement: 'resource', audienceKind: 'signed_in' })).ok).toBe(true)
    // 規則不收件：收件單位與欄位一律丟掉，對象可以是公開。
    const rules = normalizeItemInput(input({ placement: 'rules', audienceKind: 'public' }))
    expect(rules.ok && { unit: rules.value.receiverUnit, fields: rules.value.fields.length }).toEqual({ unit: 'none', fields: 0 })
  })

  it('指定組別以外的對象會丟掉組別清單；組別清單去重', () => {
    const cohort = normalizeItemInput(input({ groupIds: [G1] }))
    expect(cohort.ok && cohort.value.groupIds).toEqual([])
    const groups = normalizeItemInput(input({ audienceKind: 'groups', groupIds: [G1, G2, G1.toUpperCase()] }))
    expect(groups.ok && groups.value.groupIds).toEqual([G1, G2])
  })

  it('標題必填、有長度上限', () => {
    expect(normalizeItemInput(input({ title: '   ' })).ok).toBe(false)
    expect(normalizeItemInput(input({ title: 'x'.repeat(121) })).ok).toBe(false)
  })

  it('附件、封面、階段的 id 要是 uuid', () => {
    expect(normalizeItemInput(input({ attachmentFileIds: ['nope'] })).ok).toBe(false)
    expect(normalizeItemInput(input({ coverFileId: 'nope' })).ok).toBe(false)
    expect(normalizeItemInput(input({ stageId: 'nope' })).ok).toBe(false)
    expect(normalizeItemInput(input({ attachmentFileIds: [FILE, FILE] })).ok).toBe(true)
  })
})

describe('normalizeItemInput：時間（臺灣時間、到分鐘）', () => {
  it('datetime-local 當臺灣時間讀，秒數捨去（存截止分鐘的起點）', () => {
    const result = normalizeItemInput(input({ dueAt: '2026-11-15T23:59:42' }))
    expect(result.ok && result.value.dueAt?.toISOString()).toBe('2026-11-15T15:59:00.000Z')
  })

  it('截止不能早於開放；同一分鐘可以', () => {
    const early = normalizeItemInput(input({ opensAt: '2026-11-16T00:00', dueAt: '2026-11-15T23:59' }))
    expect(early.ok).toBe(false)
    if (!early.ok) expect(early.message).toBe('截止時間不能早於開放時間。')
    expect(normalizeItemInput(input({ opensAt: '2026-11-15T23:59', dueAt: '2026-11-15T23:59' })).ok).toBe(true)
  })

  it('開放留空＝發布即開放；截止留空的草稿可以存（發布前檢查才擋）', () => {
    const result = normalizeItemInput(input({ dueAt: '' }))
    expect(result.ok && result.value.opensAt).toBeNull()
    expect(result.ok && result.value.dueAt).toBeNull()
  })

  it('格式不對的時間拒絕', () => {
    expect(normalizeItemInput(input({ dueAt: '2026-02-30T10:00' })).ok).toBe(false)
    expect(normalizeItemInput(input({ dueAt: 'tomorrow' })).ok).toBe(false)
  })
})

describe('normalizeSchema：收件欄位結構', () => {
  it('選擇題至少一個選項、不能重複', () => {
    expect(normalizeSchema([{ key: 'q1', type: 'radio', label: '題目', options: [] }]).ok).toBe(false)
    expect(normalizeSchema([{ key: 'q1', type: 'radio', label: '題目', options: ['A', 'A'] }]).ok).toBe(false)
    const ok = normalizeSchema([{ key: 'q1', type: 'radio', label: '題目', options: [' A ', 'B', ''] }])
    expect(ok.ok && ok.value[0]!.options).toEqual(['A', 'B'])
  })

  it('代號要唯一、格式固定', () => {
    expect(
      normalizeSchema([
        { key: 'q1', type: 'text', label: 'A' },
        { key: 'q1', type: 'text', label: 'B' },
      ]).ok,
    ).toBe(false)
    expect(normalizeSchema([{ key: '1bad', type: 'text', label: 'A' }]).ok).toBe(false)
  })

  it('檔案欄位：類型只能從白名單挑、上限 1–100 MiB；沒給就是 PDF／20 MiB', () => {
    const plain = normalizeSchema([{ key: 'f', type: 'file', label: '檔案' }])
    expect(plain.ok && plain.value[0]!.fileRules).toEqual({ allowedTypes: ['pdf'], maxMiB: 20 })
    expect(normalizeSchema([{ key: 'f', type: 'file', label: '檔案', fileRules: { allowedTypes: ['exe'] } }]).ok).toBe(false)
    expect(normalizeSchema([{ key: 'f', type: 'file', label: '檔案', fileRules: { maxMiB: 101 } }]).ok).toBe(false)
  })

  it('說明文字、區段標題不能設必填；不支援的類型拒絕', () => {
    const result = normalizeSchema([{ key: 'h', type: 'heading', label: '第一部分', required: true }])
    expect(result.ok && result.value[0]!.required).toBe(false)
    expect(normalizeSchema([{ key: 'x', type: 'script', label: 'x' }]).ok).toBe(false)
  })
})

describe('publishChecks：發布前檢查（PUB-13、PUB-14）', () => {
  const now = new Date('2026-09-24T02:00:00Z')
  const state = (patch: Partial<PublishState> = {}): PublishState => ({
    placement: 'submission',
    title: '期中報告',
    audienceKind: 'cohort_students',
    groupIds: [],
    receiverUnit: 'group',
    stageId: STAGE,
    opensAt: null,
    dueAt: new Date('2026-11-15T15:59:00Z'),
    fields: [{ key: 'report', type: 'file', label: '報告', required: true }],
    ...patch,
  })
  const keysFailed = (patch: Partial<PublishState>, openAt = now) =>
    failedChecks(publishChecks(state(patch), openAt)).map((c) => c.key)

  it('完整的收件全部通過', () => {
    expect(keysFailed({})).toEqual([])
  })

  it('指定組別沒選任何組 → 擋', () => {
    expect(keysFailed({ audienceKind: 'groups', groupIds: [] })).toEqual(['audience'])
  })

  it('截止早於開放 → 擋（沒設開放時，開放＝發布當下）', () => {
    expect(keysFailed({ opensAt: new Date('2026-11-16T00:00:00Z') })).toEqual(['window'])
    expect(keysFailed({ dueAt: new Date('2026-09-01T00:00:00Z') })).toEqual(['window'])
  })

  it('收件沒有欄位也沒有上傳要求 → 擋，文案固定', () => {
    const failed = failedChecks(publishChecks(state({ fields: [{ key: 'h', type: 'heading', label: '說明', required: false }] }), now))
    expect(failed.map((c) => c.key)).toEqual(['fields'])
    expect(failed[0]!.fix).toBe(EMPTY_COLLECTION_MESSAGE)
    expect(describeFailedChecks(failed)).toContain('新增填寫欄位或上傳要求，或改用公告／資源')
  })

  it('只有上傳要求、沒有填寫欄位的收件可以發布', () => {
    expect(keysFailed({ fields: [{ key: 'f', type: 'file', label: '檔案', required: true }] })).toEqual([])
  })

  it('收件缺階段、缺截止 → 擋', () => {
    expect(keysFailed({ stageId: null, dueAt: null })).toEqual(['stage', 'due'])
  })

  it('公告不檢查截止、階段、欄位', () => {
    expect(keysFailed({ placement: 'news', receiverUnit: 'none', stageId: null, dueAt: null, fields: [] })).toEqual([])
  })
})

describe('截止文案與到期工作時間', () => {
  it('詳細畫面寫「含此分鐘，臺灣時間」', () => {
    expect(describeDeadline(new Date('2026-11-15T15:59:00Z'))).toBe('截止：2026/11/15 23:59（含此分鐘，臺灣時間）')
  })

  it('截止快照在截止分鐘結束後再等 60 秒', () => {
    expect(snapshotDueAt(new Date('2026-11-15T15:59:00Z')).toISOString()).toBe('2026-11-15T16:01:00.000Z')
  })
})

describe('canViewItem：誰看得到（也決定附件能不能下載）', () => {
  const anonymous: Viewer = { kind: 'anonymous' }
  const student = (cohort: string | null, groups: string[] = []): Viewer => ({
    kind: 'user',
    roles: ['student'],
    studentCohortId: cohort,
    groupIds: groups,
  })
  const teacher: Viewer = { kind: 'user', roles: ['teacher'], studentCohortId: null, groupIds: [] }
  const admin: Viewer = { kind: 'user', roles: ['admin'], studentCohortId: null, groupIds: [] }
  const item = (audienceKind: 'public' | 'signed_in' | 'cohort_students' | 'teachers' | 'groups', status: 'draft' | 'published' | 'archived' = 'published') => ({
    status,
    audienceKind,
    cohortId: COHORT,
    groupIds: [G1],
  })

  it('公開：連訪客都看得到', () => {
    expect(canViewItem(anonymous, item('public'))).toBe(true)
  })

  it('登入可見：訪客看不到，任何登入者看得到', () => {
    expect(canViewItem(anonymous, item('signed_in'))).toBe(false)
    expect(canViewItem(teacher, item('signed_in'))).toBe(true)
  })

  it('本屆學生：只有同屆學生；別屆學生、老師看不到', () => {
    expect(canViewItem(student(COHORT), item('cohort_students'))).toBe(true)
    expect(canViewItem(student('99999999-9999-4999-8999-999999999999'), item('cohort_students'))).toBe(false)
    expect(canViewItem(teacher, item('cohort_students'))).toBe(false)
  })

  it('指定組別：只有那幾組的成員（PUB-10：G3 看不到）', () => {
    expect(canViewItem(student(COHORT, [G1]), item('groups'))).toBe(true)
    expect(canViewItem(student(COHORT, [G2]), item('groups'))).toBe(false)
  })

  it('全部老師：只有老師', () => {
    expect(canViewItem(teacher, item('teachers'))).toBe(true)
    expect(canViewItem(student(COHORT), item('teachers'))).toBe(false)
  })

  it('草稿與下架：只有管理員看得到，公開的也一樣', () => {
    expect(canViewItem(anonymous, item('public', 'draft'))).toBe(false)
    expect(canViewItem(student(COHORT), item('cohort_students', 'archived'))).toBe(false)
    expect(canViewItem(admin, item('groups', 'draft'))).toBe(true)
  })
})

describe('sanitizeBody：正文白名單清理（契約 03 §5）', () => {
  it('<script>、事件屬性、javascript: 連結、iframe、img 全部拿掉', () => {
    const dirty =
      '<p onclick="steal()">說明<script>alert(1)</script></p>' +
      '<a href="javascript:alert(1)">壞連結</a>' +
      '<iframe src="https://evil.example"></iframe>' +
      '<img src=x onerror="alert(1)">' +
      '<p style="color:red">紅字</p>'
    const clean = sanitizeBody(dirty)
    expect(clean).not.toMatch(/script|onclick|onerror|javascript:|iframe|<img|style=/i)
    expect(clean).toContain('<p>說明</p>')
    expect(clean).toContain('<p>紅字</p>')
  })

  it('允許的排版原樣保留；連結一律 noopener、開新分頁', () => {
    const clean = sanitizeBody(
      '<h2>重點</h2><ul><li><strong>粗體</strong></li></ul><a href="https://www.fju.edu.tw" target="_self">系網</a>',
    )
    expect(clean).toContain('<h2>重點</h2>')
    expect(clean).toContain('<ul><li><strong>粗體</strong></li></ul>')
    expect(clean).toContain('href="https://www.fju.edu.tw"')
    expect(clean).toContain('rel="noopener noreferrer nofollow"')
    expect(clean).toContain('target="_blank"')
  })

  it('純文字轉成段落，而且文字會逃逸', () => {
    expect(sanitizeBody('第一段\n第二行\n\n第二段 a<b')).toBe('<p>第一段<br />第二行</p><p>第二段 a&lt;b</p>')
  })

  it('清理結果再清一次不會變（round trip 穩定）；輸出前再清也擋得住被直接改過的資料', () => {
    const once = sanitizeBody('<p>段落<a href="https://example.com">連結</a></p>')
    expect(sanitizeBody(once)).toBe(once)
    expect(renderBodyHtml('<p>ok</p><script>alert(1)</script>')).toBe('<p>ok</p>')
  })
})
