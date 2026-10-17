import { describe, expect, it } from 'vitest'
import { affairsView } from '@/app/dashboard/admin/affairs/affairs-view'

const active = { id: 'a', status: 'active', isDefaultWorking: true }
const setup = { id: 's', status: 'setup', isDefaultWorking: false }
const old1 = { id: 'h1', status: 'archived', isDefaultWorking: false }
const old2 = { id: 'h2', status: 'archived', isDefaultWorking: false }

describe('affairsView：公告與作業列表顯示哪一屆（第三波 W1b）', () => {
  it('一個屆別都沒有：none（不論篩選）', () => {
    expect(affairsView([], {})).toEqual({ state: 'none', filter: 'all' })
    expect(affairsView([], { placement: 'honor' })).toEqual({ state: 'none', filter: 'honor' })
  })

  it('一般篩選只列未封存的屆別，預設工作屆優先；指到封存屆別退回預設', () => {
    const view = affairsView([old1, setup, active], { cohort: 'h1' })
    expect(view).toMatchObject({ state: 'ok', filter: 'all', cohort: active })
    expect(view.state === 'ok' && view.cohorts.map((c) => c.id)).toEqual(['s', 'a'])
  })

  it('榮譽篩選連封存屆別也列，可以選封存屆別', () => {
    const view = affairsView([old1, active], { placement: 'honor', cohort: 'h1' })
    expect(view).toMatchObject({ state: 'ok', filter: 'honor', cohort: old1 })
    expect(view.state === 'ok' && view.cohorts.map((c) => c.id)).toEqual(['h1', 'a'])
    expect(affairsView([old1, active], { placement: 'honor' })).toMatchObject({ cohort: active })
  })

  it('全部屆別都封存：一般篩選是 only-archived（要留歷屆榮譽入口，不是「還沒有屆別」）；榮譽篩選照常列封存屆別', () => {
    expect(affairsView([old1, old2], {})).toEqual({ state: 'only-archived', filter: 'all' })
    expect(affairsView([old1, old2], { placement: 'news' })).toEqual({ state: 'only-archived', filter: 'news' })
    expect(affairsView([old1, old2], { placement: 'honor' })).toMatchObject({ state: 'ok', filter: 'honor', cohort: old1 })
    expect(affairsView([old1, old2], { placement: 'honor', cohort: 'h2' })).toMatchObject({ state: 'ok', cohort: old2 })
  })
})
