import { describe, expect, it } from 'vitest'
import { normalizeDraftFields, normalizeSummary, normalizeTitle, SHOWCASE_LIMITS, VIDEO_URL_MESSAGE } from '@/application/showcase/draft'

describe('摘要正規化（授權範圍比對的基礎）', () => {
  it('前後空白、行尾空白、Windows 換行不算改摘要；段落內文字不動', () => {
    expect(normalizeSummary('  第一段  \r\n第二段\t\n')).toBe('第一段\n第二段')
    expect(normalizeSummary('第一段\n\n第二段')).toBe('第一段\n\n第二段')
    expect(normalizeSummary('a  b')).toBe('a  b')
  })

  it('Unicode 正規化成 NFC（同一個字不同編碼算同一份摘要）', () => {
    expect(normalizeSummary('Café')).toBe('Café')
  })
})

describe('草稿三欄', () => {
  it('題目壓空白與換行；空的也可以存（草稿可以先空）', () => {
    expect(normalizeTitle('  智慧\n校園   導覽 ')).toBe('智慧 校園 導覽')
    expect(normalizeDraftFields({ title: '', summary: '', videoUrl: '' })).toEqual({
      ok: true,
      value: { title: '', summary: '', videoUrl: null },
    })
  })

  it('長度上限：題目、摘要超過就指出哪一欄', () => {
    const long = normalizeDraftFields({ title: '字'.repeat(SHOWCASE_LIMITS.title + 1), summary: '', videoUrl: '' })
    expect(long).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', details: { field: 'title' } })
    const summary = normalizeDraftFields({ title: '', summary: '字'.repeat(SHOWCASE_LIMITS.summary + 1), videoUrl: '' })
    expect(summary).toMatchObject({ ok: false, details: { field: 'summary' } })
  })

  it('影片連結要是 http(s) 完整網址；javascript:、相對路徑、中間有空白都擋', () => {
    expect(normalizeDraftFields({ title: '', summary: '', videoUrl: ' https://youtu.be/abc ' })).toMatchObject({
      ok: true,
      value: { videoUrl: 'https://youtu.be/abc' },
    })
    for (const bad of ['javascript:alert(1)', '/videos/1', 'https://you tube.com', 'ftp://x.y/z', 'https://']) {
      expect(normalizeDraftFields({ title: '', summary: '', videoUrl: bad }), bad).toMatchObject({
        ok: false,
        // 驗收 P-05：說清楚怎麼改，不只「請輸入網址」。
        message: '影片連結只收 YouTube 影片網址（例如 https://www.youtube.com/watch?v=… 或 https://youtu.be/…），不公開影片也可以。',
        details: { field: 'videoUrl' },
      })
    }
  })

  it('影片連結只收 YouTube 影片：Vimeo、頻道頁、播放清單、雲端硬碟都擋，訊息同一句、指出影片欄（Q49、AC-V13）', () => {
    for (const bad of [
      'https://vimeo.com/123',
      'https://www.youtube.com/@fjuim',
      'https://www.youtube.com/playlist?list=PL1',
      'https://drive.google.com/file/d/x',
    ]) {
      expect(normalizeDraftFields({ title: '', summary: '', videoUrl: bad }), bad).toMatchObject({
        ok: false,
        code: 'VALIDATION_FAILED',
        message: VIDEO_URL_MESSAGE,
        details: { field: 'videoUrl' },
      })
    }
  })

  it('YouTube 影片網址存使用者填的原字串（trim 後），不改寫成標準網址（AC-V12：簽核 contentHash 不受影響）', () => {
    for (const url of [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ?si=abc',
    ]) {
      expect(normalizeDraftFields({ title: '', summary: '', videoUrl: `  ${url} ` }), url).toEqual({
        ok: true,
        value: { title: '', summary: '', videoUrl: url },
      })
    }
  })
})
