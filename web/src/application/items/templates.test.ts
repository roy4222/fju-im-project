import { describe, expect, it } from 'vitest'
import { ITEM_TEMPLATES, normalizeItemInput, normalizeSchema, PROJECT_REQUIREMENT_TEMPLATE, type ItemInput } from '@/application/items'

const COHORT = '11111111-1111-4111-8111-111111111111'
const STAGE = '22222222-2222-4222-8222-222222222222'

describe('專題需求表範本（W12、AC-40）', () => {
  const fields = PROJECT_REQUIREMENT_TEMPLATE.fields

  it('7 個欄位、順序與必填同助教的 Google 表單（Q9）', () => {
    expect(fields.map((f) => [f.label, f.required])).toEqual([
      ['指導老師', true],
      ['組長', true],
      ['專題名稱（英文）', true],
      ['專題名稱（中文）', false],
      ['開發軟體', true],
      ['硬體需求', true],
      ['其他硬體', false],
    ])
  })

  it('只用既有的短文字／長文字型別，收件單位預設整組一份', () => {
    expect(new Set(fields.map((f) => f.type))).toEqual(new Set(['text', 'textarea']))
    expect(PROJECT_REQUIREMENT_TEMPLATE.receiverUnit).toBe('group')
  })

  it('欄位代號固定且不重複，伺服器的欄位檢查原樣收下', () => {
    expect(new Set(fields.map((f) => f.key)).size).toBe(fields.length)
    const normalized = normalizeSchema(fields)
    expect(normalized).toEqual({ ok: true, value: fields })
  })

  it('套用後的收件（文件繳交、整組一份）可以存：不需要開新的發布位置', () => {
    const input: ItemInput = {
      cohortId: COHORT,
      placement: 'submission',
      title: '專題需求表',
      summary: '',
      body: '',
      category: '',
      coverFileId: null,
      attachmentFileIds: [],
      audienceKind: 'cohort_students',
      groupIds: [],
      receiverUnit: PROJECT_REQUIREMENT_TEMPLATE.receiverUnit,
      stageId: STAGE,
      opensAt: '',
      dueAt: '',
      registrationDeadline: '',
      eventDate: '',
      awardedOn: '',
      fields: [...fields],
    }
    const result = normalizeItemInput(input)
    expect(result.ok).toBe(true)
  })

  it('範本清單裡範本 id 不重複', () => {
    expect(new Set(ITEM_TEMPLATES.map((t) => t.id)).size).toBe(ITEM_TEMPLATES.length)
    expect(ITEM_TEMPLATES).toContain(PROJECT_REQUIREMENT_TEMPLATE)
  })
})
