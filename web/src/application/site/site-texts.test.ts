import { describe, expect, it } from 'vitest'
import {
  FOOTER_CONTACT_FIELDS,
  isSiteTextKey,
  normalizeSiteText,
  parsePrivacyBody,
  privacyBodyOf,
  readSiteText,
  SITE_TEXT_KEYS,
  SITE_TEXT_STALE_MESSAGE,
} from '@/application/site/site-texts'

const CONTACT = {
  department: '輔仁大學資訊管理學系',
  address: '242 新北市新莊區中正路 510 號 利瑪竇大樓 LM306',
  phone: '02-2905-2666',
  siteLabel: 'im.fju.edu.tw',
  siteHref: 'https://www.im.fju.edu.tw/',
  slogan: '透過機測、專題及產業實習讓學生動手做。',
  officeNote: '專題相關事務請洽系辦公室',
  industryNote: '業界合作或產學洽詢，也請直接聯絡系辦。',
}

describe('key 清單', () => {
  it('五個 key，跟 migration 0022 的 CHECK 一致', () => {
    expect(SITE_TEXT_KEYS).toEqual(['footer_contact', 'quick_card_1', 'quick_card_2', 'quick_card_3', 'privacy'])
    expect(isSiteTextKey('quick_card_2')).toBe(true)
    expect(isSiteTextKey('hero')).toBe(false)
    expect(isSiteTextKey(null)).toBe(false)
  })

  it('版本過期的句子沿用首頁設定', () => {
    expect(SITE_TEXT_STALE_MESSAGE).toBe('這份設定剛被改過，請重新整理再改。')
  })
})

describe('頁尾聯絡資料', () => {
  it('八欄都去頭尾空白；系所、地址、電話必填，其餘可空', () => {
    const got = normalizeSiteText('footer_contact', { ...CONTACT, phone: ' 02-2905-2666 ', slogan: '', officeNote: '', industryNote: '', siteLabel: '', siteHref: '' })
    expect(got).toEqual({ ok: true, value: { ...CONTACT, slogan: '', officeNote: '', industryNote: '', siteLabel: '', siteHref: '' } })
    expect(normalizeSiteText('footer_contact', { ...CONTACT, phone: '' })).toMatchObject({ ok: false, field: 'phone', message: '請填電話。' })
    expect(normalizeSiteText('footer_contact', { ...CONTACT, address: '  ' })).toMatchObject({ ok: false, field: 'address' })
  })

  it('不准換行、字數上限以字計', () => {
    expect(normalizeSiteText('footer_contact', { ...CONTACT, address: '一行\n兩行' })).toMatchObject({ ok: false, field: 'address', message: '地址只能寫一行，請拿掉換行。' })
    expect(normalizeSiteText('footer_contact', { ...CONTACT, phone: '1'.repeat(31) })).toMatchObject({ ok: false, field: 'phone', message: '電話最多 30 字（現在 31 字）。' })
    expect(normalizeSiteText('footer_contact', { ...CONTACT, slogan: '😀'.repeat(120) })).toMatchObject({ ok: true })
  })

  it('系網網址要 http(s)，顯示文字與網址要一起填或一起留空', () => {
    expect(normalizeSiteText('footer_contact', { ...CONTACT, siteHref: 'www.im.fju.edu.tw' })).toMatchObject({ ok: false, field: 'siteHref' })
    expect(normalizeSiteText('footer_contact', { ...CONTACT, siteLabel: '' })).toMatchObject({ ok: false, field: 'siteLabel' })
    expect(normalizeSiteText('footer_contact', { ...CONTACT, siteHref: '' })).toMatchObject({ ok: false, field: 'siteHref' })
  })

  it('沒給的欄位當空字串，不會因為 undefined 掛掉', () => {
    expect(normalizeSiteText('footer_contact', { department: '系', address: '地址', phone: '02' })).toEqual({
      ok: true,
      value: { department: '系', address: '地址', phone: '02', siteLabel: '', siteHref: '', slogan: '', officeNote: '', industryNote: '' },
    })
    expect(FOOTER_CONTACT_FIELDS).toHaveLength(8)
  })
})

describe('三張卡：只有標題與說明', () => {
  it('標題必填、最多 20 字；說明可空、最多 200 字；多的欄位不收', () => {
    expect(normalizeSiteText('quick_card_2', { title: ' 我的入口 ', description: '', href: '/x' })).toEqual({ ok: true, value: { title: '我的入口', description: '' } })
    expect(normalizeSiteText('quick_card_2', { title: '', description: '說明' })).toMatchObject({ ok: false, field: 'title', message: '請填標題。' })
    expect(normalizeSiteText('quick_card_1', { title: '二十一個字的標題二十一個字的標題二十一個字', description: '' })).toMatchObject({ ok: false, field: 'title' })
    expect(normalizeSiteText('quick_card_3', { title: '系辦聯絡', description: 'x'.repeat(201) })).toMatchObject({ ok: false, field: 'description', message: '說明最多 200 字（現在 201 字）。' })
  })
})

describe('隱私權政策：純文字 ↔ 段落陣列', () => {
  const BODY = '# 我們蒐集哪些資料\n\n第一段。\n第二段。\n\n# 誰看得到\n\n只有系辦。'

  it('「# 」開頭是一節的標題，其餘非空行各是一段；空行只是分隔', () => {
    expect(parsePrivacyBody(BODY)).toEqual({
      ok: true,
      value: {
        sections: [
          { heading: '我們蒐集哪些資料', paragraphs: ['第一段。', '第二段。'] },
          { heading: '誰看得到', paragraphs: ['只有系辦。'] },
        ],
      },
    })
    expect(parsePrivacyBody('#標題\r\n內文\r\n')).toMatchObject({ ok: true, value: { sections: [{ heading: '標題', paragraphs: ['內文'] }] } })
  })

  it('還原成表單文字後再解析得到同一份', () => {
    const parsed = parsePrivacyBody(BODY)
    if (!parsed.ok) throw new Error(parsed.message)
    const body = privacyBodyOf(parsed.value)
    expect(body).toBe('# 我們蒐集哪些資料\n\n第一段。\n\n第二段。\n\n# 誰看得到\n\n只有系辦。')
    expect(parsePrivacyBody(body)).toEqual(parsed)
  })

  it('空白、沒有標題、標題沒內文、「#」沒接字、太長都擋', () => {
    expect(parsePrivacyBody('  \n')).toMatchObject({ ok: false, field: 'body', message: '請填隱私權政策的內文。' })
    expect(parsePrivacyBody('沒有標題的內文')).toMatchObject({ ok: false, message: expect.stringContaining('第一行要是一節的標題') })
    expect(parsePrivacyBody('# 只有標題')).toMatchObject({ ok: false, message: '「只有標題」這一節還沒有內文。' })
    expect(parsePrivacyBody('#\n內文')).toMatchObject({ ok: false, message: '「#」後面要接這一節的標題。' })
    expect(parsePrivacyBody(`# ${'長'.repeat(61)}\n內文`)).toMatchObject({ ok: false, message: expect.stringContaining('每節標題最多 60 字') })
    expect(parsePrivacyBody(`# 標題\n${'字'.repeat(20_000)}`)).toMatchObject({ ok: false, message: expect.stringContaining('內文最多 20000 字') })
    expect(normalizeSiteText('privacy', {})).toMatchObject({ ok: false, field: 'body' })
  })
})

describe('readSiteText：資料庫 JSON 形狀不對就當沒有列', () => {
  it('對的形狀原樣回傳；多的欄位（三張卡）丟掉', () => {
    expect(readSiteText('footer_contact', CONTACT)).toEqual(CONTACT)
    expect(readSiteText('quick_card_1', { title: 'A', description: 'B', extra: 1 })).toEqual({ title: 'A', description: 'B' })
    expect(readSiteText('privacy', { sections: [{ heading: 'H', paragraphs: ['P'] }] })).toEqual({ sections: [{ heading: 'H', paragraphs: ['P'] }] })
  })

  it('不是物件、缺欄、欄位型別不對、空節都回 null', () => {
    expect(readSiteText('footer_contact', null)).toBeNull()
    expect(readSiteText('footer_contact', 'x')).toBeNull()
    expect(readSiteText('footer_contact', { ...CONTACT, phone: 123 })).toBeNull()
    expect(readSiteText('quick_card_2', { title: 'A' })).toBeNull()
    expect(readSiteText('privacy', { sections: [] })).toBeNull()
    expect(readSiteText('privacy', { sections: [{ heading: 'H', paragraphs: [] }] })).toBeNull()
    expect(readSiteText('privacy', { sections: [{ heading: 1, paragraphs: ['P'] }] })).toBeNull()
  })
})
