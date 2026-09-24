import { describe, expect, it } from 'vitest'
import type { FormField } from '@/application/items'
import {
  answerFields,
  describeReceipt,
  isAnswerField,
  normalizeAnswers,
  phaseOf,
  statusOf,
  submitIssues,
  type StatusFacts,
} from '@/application/submissions'

/**
 * 票 17 的純規則：答案整理（草稿）、送出前檢查（必填與格式）、開放與截止、作業區狀態字、回執句子。
 */

const FIELDS: FormField[] = [
  { key: 'intro', type: 'heading', label: '基本資料', required: false },
  { key: 'note', type: 'paragraph', label: '請依實際情況填寫', required: false },
  { key: 'name', type: 'text', label: '姓名', required: true },
  { key: 'plan', type: 'textarea', label: '想做的題目', required: false },
  { key: 'mail', type: 'email', label: '聯絡信箱', required: false },
  { key: 'site', type: 'url', label: '作品網址', required: false },
  { key: 'size', type: 'number', label: '預計人數', required: false },
  { key: 'day', type: 'date', label: '可出席日期', required: false },
  { key: 'at', type: 'time', label: '可出席時間', required: false },
  { key: 'kind', type: 'radio', label: '專題類型', required: true, options: ['一般專題', '產學合作'] },
  { key: 'pick', type: 'select', label: '想選的老師', required: false, options: ['甲', '乙'] },
  { key: 'tags', type: 'checkbox', label: '興趣', required: true, options: ['網頁', 'AI', '資料'] },
  { key: 'doc', type: 'file', label: '履歷', required: false },
]

describe('哪些欄位要填', () => {
  it('區段標題與說明文字不用填；其他（含檔案）都要', () => {
    const types = ['text', 'textarea', 'number', 'email', 'url', 'radio', 'checkbox', 'select', 'date', 'time', 'file'] as const
    for (const type of types) expect(isAnswerField({ type }), type).toBe(true)
    expect(isAnswerField({ type: 'heading' })).toBe(false)
    expect(isAnswerField({ type: 'paragraph' })).toBe(false)
    expect(answerFields(FIELDS).map((f) => f.key)).not.toContain('intro')
  })
})

describe('存草稿的整理', () => {
  it('只留目前欄位、空的不存、單行去控制字元、長文字保留換行、複選照選項順序', () => {
    const result = normalizeAnswers(FIELDS, {
      name: '  王小明\t ',
      plan: '第一行\r\n第二行\u0000',
      mail: '還沒打完@',
      kind: '',
      tags: ['資料', '網頁', '資料'],
      intro: '不該存',
      ghost: '不在欄位裡',
    })
    expect(result).toEqual({
      ok: true,
      value: { name: '王小明', plan: '第一行\n第二行', mail: '還沒打完@', tags: ['網頁', '資料'] },
    })
  })

  it('格式在草稿不擋（填到一半也要存得住）', () => {
    expect(normalizeAnswers(FIELDS, { size: '三', day: '2026-02-30', site: 'abc' }).ok).toBe(true)
  })

  it('形狀不對直接拒絕：不存在的選項、複選不是陣列、單行太長', () => {
    expect(normalizeAnswers(FIELDS, { kind: '學術研究' })).toMatchObject({ ok: false, issue: { key: 'kind' } })
    expect(normalizeAnswers(FIELDS, { tags: '網頁' })).toMatchObject({ ok: false, issue: { key: 'tags' } })
    expect(normalizeAnswers(FIELDS, { tags: ['網頁', '遊戲'] })).toMatchObject({ ok: false, issue: { key: 'tags' } })
    expect(normalizeAnswers(FIELDS, { name: 'x'.repeat(501) })).toMatchObject({ ok: false, issue: { key: 'name' } })
    expect(normalizeAnswers(FIELDS, { name: 42 })).toMatchObject({ ok: false, issue: { key: 'name' } })
  })

  it('檔案欄位在票 17 不收值；不是物件的輸入當成空的', () => {
    expect(normalizeAnswers(FIELDS, { doc: 'C:\\fake.pdf' })).toEqual({ ok: true, value: {} })
    expect(normalizeAnswers(FIELDS, ['a'])).toEqual({ ok: true, value: {} })
    expect(normalizeAnswers(FIELDS, null)).toEqual({ ok: true, value: {} })
  })
})

describe('送出前檢查', () => {
  const complete = { name: '王小明', kind: '一般專題', tags: ['AI'] }

  it('必填都有就可以送', () => {
    expect(submitIssues(FIELDS, complete)).toEqual([])
  })

  it('必填沒填照欄位順序列出，文字依欄位型別', () => {
    expect(submitIssues(FIELDS, {}).map((i) => i.message)).toEqual(['請填寫「姓名」', '請選擇「專題類型」', '請勾選「興趣」'])
  })

  it('有填的欄位檢查格式', () => {
    const issues = submitIssues(FIELDS, {
      ...complete,
      mail: 'not-mail',
      site: 'ftp://x',
      size: '三',
      day: '2026-02-30',
      at: '25:00',
    })
    expect(issues.map((i) => i.key)).toEqual(['mail', 'site', 'size', 'day', 'at'])
    expect(
      submitIssues(FIELDS, { ...complete, mail: 'a@b.tw', site: 'https://x.tw', size: '-3.5', day: '2028-02-29', at: '23:59' }),
    ).toEqual([])
  })

  it('必填的檔案欄位擋下並說明上傳尚未開放（不假裝收到）', () => {
    const withFile: FormField[] = [{ key: 'report', type: 'file', label: '報告 PDF', required: true }]
    const [only] = submitIssues(withFile, {})
    expect(only?.message).toMatch(/報告 PDF.*上傳功能尚未開放/)
  })
})

describe('開放與截止（業務時間）', () => {
  const dueAt = new Date('2026-11-15T15:59:00Z') // 臺灣 11/15 23:59

  it('看設定的開放時間；沒設就是發布即開放', () => {
    const opensAt = new Date('2026-11-01T00:00:00Z')
    expect(phaseOf({ opensAt, dueAt }, new Date('2026-10-31T23:59:59Z'))).toBe('not_open')
    expect(phaseOf({ opensAt, dueAt }, opensAt)).toBe('open')
    expect(phaseOf({ opensAt: null, dueAt }, new Date('2020-01-01T00:00:00Z'))).toBe('open')
  })

  it('截止分鐘內（23:59:59）仍可送、下一分鐘 00:00:00 就截止', () => {
    expect(phaseOf({ opensAt: null, dueAt }, new Date('2026-11-15T15:59:59.999Z'))).toBe('open')
    expect(phaseOf({ opensAt: null, dueAt }, new Date('2026-11-15T16:00:00Z'))).toBe('closed')
  })
})

describe('作業區狀態字', () => {
  const facts = (patch: Partial<StatusFacts>): StatusFacts => ({
    phase: 'open',
    opensAt: null,
    latestVersionNo: null,
    hasDraft: false,
    exempt: false,
    ...patch,
  })

  it('尚未開放／進行中／草稿已存／已繳 vN／截止後唯讀／逾期未繳／免填', () => {
    const opensAt = new Date('2027-02-01T00:00:00Z')
    expect(statusOf(facts({ phase: 'not_open', opensAt }))).toMatchObject({
      headline: '尚未開放',
      detail: '2027/02/01 08:00 開放',
      editable: false,
    })
    expect(statusOf(facts({}))).toMatchObject({ headline: '未繳', detail: '進行中', pending: true, action: '去繳交' })
    expect(statusOf(facts({ hasDraft: true }))).toMatchObject({ headline: '未繳', action: '繼續填寫', pending: true })
    expect(statusOf(facts({ latestVersionNo: 2 }))).toMatchObject({
      headline: '已繳 v2',
      editable: true,
      submitted: true,
      pending: false,
      action: '查看或重送',
    })
    expect(statusOf(facts({ latestVersionNo: 2, phase: 'closed' }))).toMatchObject({
      headline: '已繳 v2',
      detail: '截止後唯讀',
      editable: false,
      overdue: false,
    })
    expect(statusOf(facts({ phase: 'closed' }))).toMatchObject({ headline: '逾期未繳', overdue: true, editable: false })
    expect(statusOf(facts({ exempt: true }))).toMatchObject({ headline: '免填', editable: false, pending: false })
  })
})

describe('回執句子', () => {
  it('寫第幾次與秒級的收件時間（臺灣時間）', () => {
    expect(describeReceipt({ title: '意向調查', versionNo: 2, receivedBusinessAt: '2026-11-15T15:59:59.000Z' })).toBe(
      '「意向調查」已收件：第 2 次正式送出，收件時間 2026/11/15 23:59:59（臺灣時間）。',
    )
  })
})
