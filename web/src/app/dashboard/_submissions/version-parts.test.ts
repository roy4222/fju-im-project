import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { MyVersionDetail, VersionSummary } from '@/application/submissions'

// composition 會連資料庫；畫面只用到兩個純函式，直接拿 application 的。
vi.mock('@/composition/submissions', async () => {
  const m = await import('@/application/submissions')
  return { answerFields: m.answerFields, isFileField: m.isFileField }
})

import { VersionContent, VersionTable } from '@/app/dashboard/_submissions/version-parts'

const summary: VersionSummary = {
  versionNo: 2,
  receivedBusinessAt: new Date('2026-10-01T04:05:06Z'),
  receivedRealAt: new Date('2026-10-01T04:05:06Z'),
  submittedByName: '王小明',
  schemaVersionNo: 7,
  requestId: 'req-1',
  late: false,
}

const detail: MyVersionDetail = {
  ...summary,
  isLatest: true,
  fields: [{ key: 'topic', label: '題目', type: 'text' } as MyVersionDetail['fields'][number]],
  answers: { topic: '智慧農業' },
  files: [],
}

const table = (extra: { showSchemaVersion?: boolean } = {}) =>
  renderToStaticMarkup(createElement(VersionTable, { versions: [summary], hrefOf: (n: number) => `/v/${n}`, ...extra }))

const content = (extra: { showSchemaVersion?: boolean } = {}) =>
  renderToStaticMarkup(createElement(VersionContent, { version: detail, backHref: '/back', backLabel: '回列表', ...extra }))

describe('VersionTable 的 showSchemaVersion（AC-SH-64）', () => {
  it('不給：有「表單」欄與「第 N 版」', () => {
    const html = table()
    expect(html).toContain('>表單</th>')
    expect(html).toMatch(/第 (<!-- -->)?7(<!-- -->)? 版/)
  })

  it('false：「表單」欄與「第 N 版」都不見，其他欄位照舊', () => {
    const html = table({ showSchemaVersion: false })
    expect(html).not.toContain('表單')
    expect(html).not.toMatch(/第 (<!-- -->)?7(<!-- -->)? 版/)
    expect(html).toContain('第幾次')
    expect(html).toContain('送出者')
    expect(html).toContain('送出時間（臺灣時間）')
    expect(html).toContain('王小明')
    expect(html).toContain('查看內容')
    expect(html).toContain('href="/v/2"')
  })

  it('false 只拿掉那一欄：表頭與每列的格數一致', () => {
    const on = table()
    const off = table({ showSchemaVersion: false })
    expect(on.match(/<th /g)).toHaveLength(5)
    expect(on.match(/<td /g)).toHaveLength(5)
    expect(off.match(/<th /g)).toHaveLength(4)
    expect(off.match(/<td /g)).toHaveLength(4)
  })
})

describe('VersionContent 的 showSchemaVersion（AC-SH-64）', () => {
  it('不給：有「表單」那一列與「第 7 版」', () => {
    const html = content()
    expect(html).toContain('<dt class="w-16 shrink-0 text-muted-foreground">表單</dt>')
    expect(html).toContain('第 7 版')
  })

  it('false：「表單」列不見，其他列與答案照舊', () => {
    const html = content({ showSchemaVersion: false })
    expect(html).not.toContain('表單')
    expect(html).not.toContain('第 7 版')
    expect(html).toContain('送出時間')
    expect(html).toContain('送出者')
    expect(html).toContain('王小明')
    expect(html).toContain('題目')
    expect(html).toContain('智慧農業')
    expect(html).toContain('data-testid="version-view"')
  })
})
