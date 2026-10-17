import { describe, expect, it } from 'vitest'
import { OTHER_ROUTE, routeName } from './route-names'

describe('routeName：實際路徑 → 固定路由名稱（AC-VI-68）', () => {
  it('靜態頁原樣', () => {
    expect(routeName('/')).toBe('/')
    expect(routeName('/projects')).toBe('/projects')
    expect(routeName('/news')).toBe('/news')
    expect(routeName('/reset-password')).toBe('/reset-password')
  })

  it('動態段換成 :參數名，不帶個別 ID', () => {
    expect(routeName('/projects/0192f1c2-aaaa-7bbb-8ccc-123456789abc')).toBe('/projects/:id')
    expect(routeName('/news/42')).toBe('/news/:id')
    expect(routeName('/dashboard/admin/grading/apply/v-1')).toBe('/dashboard/admin/grading/apply/:versionId')
    expect(routeName('/dashboard/teacher/grading/g-1')).toBe('/dashboard/teacher/grading/:groupId')
  })

  it('靜態段優先於動態段', () => {
    expect(routeName('/projects/featured')).toBe('/projects/featured')
    expect(routeName('/dashboard/admin/editor/new')).toBe('/dashboard/admin/editor/new')
    expect(routeName('/dashboard/admin/grading/rules')).toBe('/dashboard/admin/grading/rules')
  })

  it('query 與 hash 一律丟掉', () => {
    expect(routeName('/projects?q=王小明')).toBe('/projects')
    expect(routeName('/reset-password?token=TESTTOKEN123')).toBe('/reset-password')
    expect(routeName('/news#top')).toBe('/news')
  })

  it('尾斜線不影響', () => {
    expect(routeName('/projects/')).toBe('/projects')
  })

  it('對不到樣板的路徑送 /(other)，不送原路徑', () => {
    expect(routeName('/wang@example.com')).toBe(OTHER_ROUTE)
    expect(routeName('/projects/abc/extra')).toBe(OTHER_ROUTE)
    expect(routeName('/api/files/123')).toBe(OTHER_ROUTE)
  })
})
