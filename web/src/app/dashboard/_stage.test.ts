import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Cohort, CohortSchedule } from '@/application/cohorts'

// 橫幅只用到純函式；查詢工廠擋掉，單元測試不連資料庫。
vi.mock('@/composition/cohorts', async () => {
  const app = await vi.importActual<typeof import('@/application/cohorts')>('@/application/cohorts')
  const unused = () => {
    throw new Error('單元測試不查資料庫')
  }
  return {
    cohortLabel: app.cohortLabel,
    describeStagePosition: app.describeStagePosition,
    stagePositionAt: app.stagePositionAt,
    getBusinessClockQuery: unused,
    getCohortStatusQuery: unused,
    getTimelineQuery: unused,
  }
})

const { HomeHero } = await import('./_stage')
type Ctx = Parameters<typeof HomeHero>[0]['ctx']

const cohort = { id: 'c1', code: '115', name: '115 級' } as Cohort
const schedule: CohortSchedule = {
  stages: [
    { seq: 1, name: '提案', description: '', startDate: '2026-09-15', deadlineVersion: 1 },
    { seq: 2, name: '期中', description: '', startDate: '2026-11-01', deadlineVersion: 1 },
    { seq: 3, name: '期末', description: '', startDate: '2027-01-01', deadlineVersion: 1 },
    { seq: 4, name: '成果', description: '', startDate: '2027-04-01', deadlineVersion: 1 },
  ],
  yearEndDate: '2027-06-30',
}

/** 固定 fixture：階段 2「期中」，今天 12-19，到 12-31 結束＝距結束 12 天（AC-SH-24a）。 */
const ctx: Ctx = {
  cohort,
  schedule,
  position: { kind: 'in_stage', seq: 2, name: '期中', lastDate: '2026-12-31' },
  today: '2026-12-19',
  businessNow: new Date('2026-12-19T04:00:00Z'),
  simulated: false,
}

const render = (props: Partial<Parameters<typeof HomeHero>[0]>) =>
  renderToStaticMarkup(createElement(HomeHero, { ctx, perspective: 'student', name: '王小明', line: '還有 2 件作業要交', ...props }))

/** 每種寫法都要有的固定鉤子（AC-SH-01～05 與 e2e 讀的那幾個）。 */
function expectFixedHooks(html: string) {
  expect(html).toMatch(/^<section [^>]*aria-label="現在階段"/)
  expect(html).toMatch(/^<section [^>]*class="hero"/)
  expect(html).toMatch(/<h1[^>]*>歡迎回來，王小明<\/h1>/)
  expect(html).toMatch(/>現在</)
  expect(html).toMatch(/<span [^>]*data-testid="stage-text"[^>]*>階段 2：期中<\/span>/)
  expect(html).toContain('還有 12 天')
  expect(html).not.toContain('style=')
}

describe('HomeHero 新介面（AC-SH-24a (a)）', () => {
  const html = render({
    timelineHref: '/timeline',
    cta: { label: '繼續評分', href: '/dashboard/teacher/grading' },
    next: { title: '期中報告', due: '12-22 截止・剩 3 天', href: '/dashboard/student/affairs/1', label: '去繳交' },
  })

  it('固定鉤子都在：section、h1、小字「現在」、stage-text、還有 12 天，沒有 style 屬性', () => {
    expectFixedHooks(html)
    expect(html).toContain('還有 2 件作業要交')
  })

  it('「看完整時程」連到 timelineHref', () => {
    expect(html).toMatch(/<a [^>]*href="\/timeline"[^>]*>看完整時程/)
  })

  it('cta 的字樣只出現一次', () => {
    expect(html.split('繼續評分')).toHaveLength(2)
    expect(html).toMatch(/<a [^>]*href="\/dashboard\/teacher\/grading"/)
  })

  it('next 白卡在 hero-next 裡：標題、到期、按鈕', () => {
    const card = html.slice(html.indexOf('data-testid="hero-next"'))
    expect(card).toContain('下一件要交的')
    expect(card).toContain('期中報告')
    expect(card).toContain('12-22 截止・剩 3 天')
    expect(card).toMatch(/<a [^>]*href="\/dashboard\/student\/affairs\/1"[^>]*>去繳交/)
  })

  it('next 也可以是角色自己畫的 ReactNode，一樣包在 hero-next 裡', () => {
    const custom = render({ next: createElement('p', { id: 'mine' }, '自己的卡') })
    expect(custom).toMatch(/data-testid="hero-next"[^>]*><p id="mine">自己的卡<\/p>/)
  })
})

describe('只傳舊 props（AC-SH-24a (b)、AC-SH-26）', () => {
  const html = render({
    chips: [{ label: '作業待繳', value: '1 件', href: '/x', hot: true, testId: 'home-pending' }],
    showStages: true,
    showProgress: true,
    icon: createElement('svg', { 'data-icon': 'school' }),
    compact: true,
  })

  it('舊 props 被忽略：沒有進度 SVG、本屆階段清單、home-pending、插圖', () => {
    expect(html).not.toContain('<svg role="img"')
    expect(html).not.toContain('本屆進度')
    expect(html).not.toContain('aria-label="本屆階段"')
    expect(html).not.toContain('home-pending')
    expect(html).not.toContain('作業待繳')
    expect(html).not.toContain('data-icon="school"')
  })

  it('固定鉤子照樣在；天數從 ctx 自動算', () => {
    expectFixedHooks(html)
  })

  it('沒有 next 就沒有 hero-next，沒有 timelineHref 就沒有「看完整時程」', () => {
    expect(html).not.toContain('hero-next')
    expect(html).not.toContain('看完整時程')
  })
})

describe('其他狀態', () => {
  it('stage prop 蓋過從 ctx 算的字與天數；daysLeft 是 null 就不寫天數', () => {
    const html = render({ stage: { text: '期中週', daysLeft: null } })
    expect(html).toMatch(/data-testid="stage-text"[^>]*>期中週</)
    expect(html).not.toMatch(/還有 \d+ 天/)
  })

  it('尚未開始時 stage 給的天數照樣顯示', () => {
    const notStarted: Ctx = { ...ctx, position: { kind: 'not_started', firstStartDate: '2026-12-25' } }
    expect(render({ ctx: notStarted })).toContain('第 1 階段 12-25 開始')
    expect(render({ ctx: notStarted, stage: { text: '尚未開始', daysLeft: 6 } })).toContain('還有 6 天')
  })

  it('next 是 0 或空字串（`n && <卡/>` 寫法）不畫空白卡', () => {
    expect(render({ next: 0 })).not.toContain('hero-next')
    expect(render({ next: '' })).not.toContain('hero-next')
  })

  it('這一段最後一天寫「今天是最後一天」', () => {
    const html = render({ ctx: { ...ctx, today: '2026-12-31' } })
    expect(html).toContain('今天是最後一天')
  })

  it('職員沒有預設屆別：只說「還沒有設定後台預設查看的屆別。」，不再叫人去屆別頁（AC-SH-68）', () => {
    const html = render({ perspective: 'staff', ctx: { ...ctx, cohort: null, schedule: null, position: null } })
    expect(html).toContain('還沒有設定後台預設查看的屆別。')
    expect(html).not.toContain('「屆別」頁')
    expect(html).not.toContain('stage-text')
  })

  it('學生沒有屆別：原本那句不變', () => {
    const html = render({ ctx: { ...ctx, cohort: null, schedule: null, position: null } })
    expect(html).toContain('你還沒有歸屬的屆別；帳號核准並歸到某一屆之後，這裡會顯示現在的階段。')
  })

  it('trail：伺服器端不渲染拖尾（hero-trail 在瀏覽器符合條件才掛），也沒有 canvas', () => {
    const html = render({ trail: true })
    expect(html).not.toContain('<canvas')
    expectFixedHooks(html)
  })
})
