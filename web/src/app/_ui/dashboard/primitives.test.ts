import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PageTitle } from './primitives'

// AC-SH-19 的 unit 段（網站問題 #8）：狀態句放 `note` 獨占一列、actions 不再 shrink-0。
// 真的版面（標題不直排、actions 換列）由 e2e/page-title.spec.ts 在成績管理頁量。
const NOTE = '已建立評分規則第 2 版（草稿）；「發布」在下方「評分規則」區塊的「版本紀錄」裡，點開後按第 2 版那列的「發布」，老師才會用這一版。'

const buttons = createElement(
  Fragment,
  null,
  createElement('button', { type: 'button' }, '評分要求與指派'),
  createElement('button', { type: 'button' }, '版本紀錄'),
  createElement('button', { type: 'button' }, '建立新版評分規則'),
)

function classOf(html: string, tag: RegExp): string {
  const m = html.match(tag)
  if (!m) throw new Error(`找不到 ${tag}`)
  return m[1]!
}

describe('PageTitle（AC-SH-19）', () => {
  const html = renderToStaticMarkup(createElement(PageTitle, { title: '成績管理', description: '說明', actions: buttons, note: NOTE }))

  it('note 渲染成 <p role="status">，class 含 basis-full，排在標題列與 actions 之後', () => {
    expect(NOTE.length).toBeGreaterThanOrEqual(60)
    const note = html.match(/<p ([^>]*)>([^<]*)<\/p>/g)?.find((p) => p.includes(NOTE))
    expect(note).toBeDefined()
    expect(note).toMatch(/role="status"/)
    expect(note).toMatch(/class="[^"]*\bbasis-full\b/)
    expect(html.indexOf(NOTE)).toBeGreaterThan(html.indexOf('成績管理'))
    expect(html.indexOf(NOTE)).toBeGreaterThan(html.indexOf('建立新版評分規則'))
  })

  it('外層 flex-wrap；標題區至少 16rem；actions 外層沒有 shrink-0', () => {
    expect(classOf(html, /^<div class="([^"]*)"/)).toMatch(/\bflex\b.*\bflex-wrap\b/)
    expect(classOf(html, /<div class="([^"]*)"><h1/)).toContain('flex-[1_1_16rem]')
    const actions = classOf(html, /<div class="([^"]*)" data-testid="page-title-actions"/)
    expect(actions).toMatch(/\bflex-wrap\b/)
    expect(actions).toMatch(/\bmax-w-full\b/)
    expect(actions).not.toMatch(/\bshrink-0\b/)
  })

  it('標題 40px／900／深藍（ink）', () => {
    const h1 = classOf(html, /<h1 class="([^"]*)"/)
    expect(h1).toContain('text-[40px]')
    expect(h1).toContain('font-black')
    expect(h1).toContain('text-ink')
  })

  it('沒有 style 屬性；沒給 note、actions 就不畫（既有呼叫不變）', () => {
    expect(html).not.toContain('style=')
    const bare = renderToStaticMarkup(createElement(PageTitle, { title: '首頁' }))
    expect(bare).not.toContain('role="status"')
    expect(bare).not.toContain('page-title-actions')
  })
})
