import { describe, expect, it } from 'vitest'
import type { ItemDetail } from '@/application/items'
import {
  blurError,
  CONSENT_FILE_KEY,
  defaultItemDraft,
  errorKeyOfCheck,
  lockedFieldsNotice,
  notifyPreviewText,
  stateFromInitial,
  switchPlacement,
  toInitial,
  toPayload,
  validateItemForm,
} from '@/app/dashboard/admin/affairs/item-form-model'

const INPUTS = ['text', 'textarea', 'number', 'email', 'url', 'radio', 'checkbox', 'select', 'date', 'time', 'file']
const EMPTY = '新增填寫欄位或上傳要求，或改用公告／資源'

describe('發布前檢查的「會通知幾位」說明（驗收第 2 章 P-06）', () => {
  it('新發布的公告／資源：只有勾「重要公告」才通知，句子照實寫條件', () => {
    expect(notifyPreviewText(12, 'important')).toBe('若勾選「重要公告」，會通知 12 位。')
  })

  it('修改已發布的項目：勾了通知這次的修改才通知', () => {
    expect(notifyPreviewText(8, 'update')).toBe('若勾選通知這次的修改，會通知 8 位。')
  })

  it('榮譽榜不發通知；對象裡沒有人時照舊說沒有可以通知的人', () => {
    expect(notifyPreviewText(12, 'never')).toBe('榮譽榜不發站內通知。')
    expect(notifyPreviewText(0, 'important')).toBe('這個對象目前沒有可以通知的人。')
  })
})

function detail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    cohortId: '00000000-0000-4000-8000-0000000000c1',
    placement: 'submission',
    status: 'published',
    title: '期中報告',
    summary: '一句話',
    bodyHtml: '<p>請上傳</p>',
    category: null,
    cover: null,
    attachments: [
      { fileId: 'f1', name: '說明.pdf', sizeBytes: 100 },
      { fileId: 'f2', name: '範本.docx', sizeBytes: 200 },
    ],
    audienceKind: 'groups',
    groupIds: ['g1', 'g3'],
    receiverUnit: 'group',
    stageId: 's-old',
    consentMode: null,
    consentPurpose: null,
    opensAt: null,
    actualOpenedAt: new Date('2026-10-01T00:00:00Z'),
    // 臺灣 2026-11-02 23:59
    dueAt: new Date('2026-11-02T15:59:00Z'),
    registrationDeadline: null,
    eventDate: null,
    awardedOn: null,
    deadlineVersion: 1,
    fields: [
      { key: 'fa', type: 'text', label: '組名', required: true },
      { key: 'fb', type: 'file', label: '報告', required: true, fileRules: { allowedTypes: ['pdf'], maxMiB: 30 } },
    ],
    revision: 7,
    contentVersionNo: 1,
    schemaVersionNo: 1,
    rosterCount: 2,
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    hasResponses: false,
    publications: [
      {
        action: 'publish',
        notify: true,
        actorUserId: 'u1',
        actorName: '系辦',
        actorAvatarPreset: 3,
        actorAvatarFileId: null,
        realAt: new Date('2026-10-01T00:00:00Z'),
      },
    ],
    ...overrides,
  }
}

describe('toInitial：ItemDetail → 表單初值（§2.7、AC-6a）', () => {
  it('附件、指定組別、繳交欄位整份帶進來；時間轉成臺灣時間的 datetime-local；revision 取自 detail', () => {
    const initial = toInitial(detail())
    expect(initial).toMatchObject({
      placement: 'submission',
      revision: 7,
      status: 'published',
      title: '期中報告',
      bodyHtml: '<p>請上傳</p>',
      audienceKind: 'groups',
      groupIds: ['g1', 'g3'],
      receiverUnit: 'group',
      stageId: 's-old',
      dueAt: '2026-11-02T23:59',
      opensAt: '',
      category: '',
      consentMode: null,
      consentPurpose: '',
      hasResponses: false,
      responseCount: 0,
    })
    expect(initial.attachments.map((a) => a.fileId)).toEqual(['f1', 'f2'])
    expect(initial.fields.map((f) => [f.key, f.type, f.label, f.maxMiB])).toEqual([
      ['fa', 'text', '組名', 20],
      ['fb', 'file', '報告', 30],
    ])
    expect(initial.publications[0]).toMatchObject({ actorUserId: 'u1', actorAvatarPreset: 3 })
  })

  it('只改標題後送出：附件、組別、欄位、舊階段原樣送回（不會被清掉）', () => {
    const state = { ...stateFromInitial(toInitial(detail())), title: '期中報告（改）' }
    const payload = toPayload(state)
    expect(payload).toMatchObject({
      title: '期中報告（改）',
      attachmentFileIds: ['f1', 'f2'],
      audienceKind: 'groups',
      groupIds: ['g1', 'g3'],
      receiverUnit: 'group',
      stageId: 's-old',
      dueAt: '2026-11-02T23:59',
    })
    expect(payload.fields.map((f) => f.key)).toEqual(['fa', 'fb'])
  })

  it('舊的 requirement 以作業載入；有人交過時帶入交過的數量', () => {
    const initial = toInitial(detail({ placement: 'requirement', hasResponses: true }), 1)
    expect(initial.placement).toBe('submission')
    expect(initial.responseCount).toBe(1)
    expect(toInitial(detail({ hasResponses: true })).responseCount).toBeNull()
  })
})

describe('defaultItemDraft：新增的預設值', () => {
  it('作業：本屆學生、整組一份、先放一個檔案欄；公告不收件', () => {
    const work = defaultItemDraft('submission', 'c1')
    expect(work).toMatchObject({ cohortId: 'c1', audienceKind: 'cohort_students', receiverUnit: 'group', status: 'draft', revision: 0 })
    expect(work.fields.map((f) => f.type)).toEqual(['file'])
    expect(defaultItemDraft('news', 'c1')).toMatchObject({ receiverUnit: 'none', fields: [] })
  })

  it('規則與榮譽固定公開訪客；前台「指定組別」區塊預填組別', () => {
    expect(defaultItemDraft('rules', 'c1').audienceKind).toBe('public')
    expect(defaultItemDraft('honor', 'c1').audienceKind).toBe('public')
    expect(defaultItemDraft('submission', 'c1', { presetGroupIds: ['g1'] })).toMatchObject({ audienceKind: 'groups', groupIds: ['g1'] })
  })

  it('同意書：站內表單沒有繳交欄位、整組；下載再上傳預設「簽好的同意書」檔案欄、個人一份（AC-24）', () => {
    expect(defaultItemDraft('submission', 'c1', { consentMode: 'form' })).toMatchObject({ consentMode: 'form', fields: [], receiverUnit: 'group' })
    const upload = defaultItemDraft('submission', 'c1', { consentMode: 'upload' })
    expect(upload.receiverUnit).toBe('individual')
    expect(upload.fields).toEqual([
      expect.objectContaining({ key: CONSENT_FILE_KEY, type: 'file', label: '簽好的同意書', allowedTypes: ['pdf', 'jpg', 'png'], maxMiB: 20 }),
    ])
    // 公告不吃同意書模式。
    expect(defaultItemDraft('news', 'c1', { consentMode: 'upload' }).consentMode).toBeNull()
  })

  it('站內同意書送出不帶欄位、帶用途；一般作業不帶用途', () => {
    const consent = { ...stateFromInitial(defaultItemDraft('submission', 'c1', { consentMode: 'form' })), consentPurpose: 'final_document' }
    expect(toPayload(consent)).toMatchObject({ consentMode: 'form', consentPurpose: 'final_document', fields: [] })
    const work = { ...stateFromInitial(defaultItemDraft('submission', 'c1')), consentPurpose: 'final_document' }
    expect(toPayload(work)).toMatchObject({ consentMode: null, consentPurpose: null })
  })
})

describe('switchPlacement：新增頁換位置時保留已填的內容', () => {
  it('公告換成作業：標題正文保留、對象改成合法值、補一個檔案欄', () => {
    const news = { ...stateFromInitial(defaultItemDraft('news', 'c1')), title: 'T', body: 'B', audienceKind: 'public' }
    const work = switchPlacement(news, 'submission', ['cohort_students', 'groups', 'teachers'])
    expect(work).toMatchObject({ placement: 'submission', title: 'T', body: 'B', audienceKind: 'cohort_students', receiverUnit: 'group' })
    expect(work.fields).toHaveLength(1)
    expect(switchPlacement(work, 'rules', [])).toMatchObject({ audienceKind: 'public', receiverUnit: 'none' })
  })
})

describe('必填當下就擋（§2.5、AC-2）', () => {
  const blank = stateFromInitial(defaultItemDraft('submission', 'c1'))

  it('新作業標題與截止都空：發布時還缺 2 項（預設已有一個檔案欄）', () => {
    const errors = validateItemForm(blank, 'publish', INPUTS, EMPTY)
    expect(errors).toEqual({ title: '請填標題', dueAt: '請填截止時間' })
  })

  it('儲存（先不發布）只要標題；截止早於開放兩邊都擋', () => {
    expect(validateItemForm(blank, 'draft', INPUTS, EMPTY)).toEqual({ title: '請填標題' })
    const reversed = { ...blank, title: 'T', opensAt: '2026-11-02T10:00', dueAt: '2026-11-01T10:00' }
    expect(validateItemForm(reversed, 'draft', INPUTS, EMPTY)).toEqual({ dueAt: '截止不能早於開放時間' })
    expect(validateItemForm(reversed, 'publish', INPUTS, EMPTY)).toEqual({ dueAt: '截止不能早於開放時間' })
  })

  it('指定組別沒選、沒有可填欄位、站內同意書沒選用途', () => {
    const groups = { ...blank, title: 'T', dueAt: '2026-11-01T10:00', audienceKind: 'groups', fields: [] }
    expect(validateItemForm(groups, 'publish', INPUTS, EMPTY)).toEqual({ audience: '指定組別至少選一組', fields: EMPTY })
    const consent = { ...stateFromInitial(defaultItemDraft('submission', 'c1', { consentMode: 'form' })), title: 'T' }
    // 站內同意書：截止選填、沒有繳交欄位，但要選用途。
    expect(validateItemForm(consent, 'publish', INPUTS, EMPTY)).toEqual({ consentPurpose: '請在進階設定選同意書的用途' })
  })

  it('公告不要求截止與欄位', () => {
    const news = { ...stateFromInitial(defaultItemDraft('news', 'c1')), title: '說明會' }
    expect(validateItemForm(news, 'publish', INPUTS, EMPTY)).toEqual({})
  })

  it('blur 當下只驗那一欄', () => {
    expect(blurError(blank, 'title')).toBe('請填標題')
    expect(blurError(blank, 'dueAt')).toBe('請填截止時間')
    expect(blurError(stateFromInitial(defaultItemDraft('news', 'c1')), 'dueAt')).toBeUndefined()
  })

  it('伺服器的檢查代碼對到畫面上的欄位', () => {
    expect(errorKeyOfCheck('window')).toBe('dueAt')
    expect(errorKeyOfCheck('consent_purpose')).toBe('consentPurpose')
    expect(errorKeyOfCheck('consent_drafts')).toBeNull()
  })
})

describe('有人交過的提示（AC-5）', () => {
  it('整組寫「組」、個人寫「人」；算不到數字時不寫數字', () => {
    expect(lockedFieldsNotice(1, 'group')).toBe('已有 1 組交過，欄位結構不能改')
    expect(lockedFieldsNotice(3, 'individual')).toBe('已有 3 人交過，欄位結構不能改')
    expect(lockedFieldsNotice(null, 'group')).toBe('已經有人交過，欄位結構不能改')
  })
})
