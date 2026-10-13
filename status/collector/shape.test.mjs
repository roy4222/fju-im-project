// 白名單投影（lib/shape.mjs）：輸出只由列出的欄位組成、值要符合型別與樣式，錯誤訊息只帶路徑不帶值。
import { describe, expect, it } from 'vitest'
import { ShapeError, T, project } from './lib/shape.mjs'

const ISO = /^\d{4}-\d{2}-\d{2}T/

describe('T.obj 只複製列出的欄位', () => {
  const shape = T.obj({ a: T.int(), b: T.optional(T.str(/^[a-z]+$/)), c: T.nullable(T.bool()) })

  it('沒列的欄位一律丟掉，列出的照順序輸出', () => {
    const out = project(shape, { c: null, extra: 'FAKEPASS001', a: 1, password: 'FAKEPASS002' })
    expect(out).toEqual({ a: 1, c: null })
    expect(Object.keys(out)).toEqual(['a', 'c'])
    expect(JSON.stringify(out)).not.toContain('FAKEPASS')
  })

  it('必要欄位缺了就丟 ShapeError、路徑指到那欄；optional 缺了就不輸出', () => {
    expect(() => project(shape, { a: 1 })).toThrow(ShapeError)
    expect(() => project(shape, { a: 1 })).toThrow(/^c：/)
    expect(project(shape, { a: 2, c: true })).toEqual({ a: 2, c: true })
    expect(project(shape, { a: 2, b: 'ok', c: false })).toEqual({ a: 2, b: 'ok', c: false })
  })

  it('不是物件（陣列、字串、null）都拒絕', () => {
    for (const bad of [[], 'x', null, 3]) expect(() => project(shape, bad)).toThrow(ShapeError)
  })
})

describe('值的型別與樣式', () => {
  it('字串：型別不對、樣式不符、太長都拒絕；錯誤訊息不帶值但附黑名單類別', () => {
    const shape = T.obj({ ci: T.obj({ url: T.str(/^https:\/\/github\.com\/[A-Za-z0-9._/-]+$/) }) })
    let err
    try {
      project(shape, { ci: { url: 'https://github.com/x/runs/11?dp.st.prd.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ShapeError)
    expect(err.path).toBe('ci.url')
    expect(err.message).not.toContain('dp.st')
    expect(err.leakKinds).toContain('token')
    expect(() => project(shape, { ci: { url: 42 } })).toThrow(/ci\.url：/)
    expect(() => project(T.str(null, 3), 'abcd')).toThrow(ShapeError)
    expect(project(T.str(null, 3), 'abc')).toBe('abc')
  })

  it('整數只收整數；布林只收布林；nullable 收 null；oneOf 只收清單內的值', () => {
    expect(project(T.int(), 3)).toBe(3)
    for (const bad of [1.5, '1', Number.NaN, null, true]) expect(() => project(T.int(), bad)).toThrow(ShapeError)
    for (const bad of ['true', 1, null]) expect(() => project(T.bool(), bad)).toThrow(ShapeError)
    expect(project(T.nullable(T.int()), null)).toBeNull()
    expect(project(T.oneOf(['false', 'absent', 'other']), 'absent')).toBe('absent')
    expect(() => project(T.oneOf(['false', 'absent', 'other']), 'FAKEPASS003')).toThrow(/格式不符/)
  })

  it('陣列：每個元素投影、路徑帶索引、超過上限拒絕', () => {
    const shape = T.obj({ items: T.arr(T.obj({ id: T.str(/^[a-z-]+$/) }), 3) })
    expect(project(shape, { items: [{ id: 'a', x: 1 }, { id: 'b' }] })).toEqual({ items: [{ id: 'a' }, { id: 'b' }] })
    expect(() => project(shape, { items: [{ id: 'a' }, { id: 'b' }, { id: 'BAD' }] })).toThrow(/items\[2\]\.id：/)
    expect(() => project(shape, { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] })).toThrow(ShapeError)
    expect(() => project(shape, { items: {} })).toThrow(ShapeError)
  })

  it('record：鍵要符合樣式、值照 shape 投影', () => {
    const shape = T.record(/^[a-z]+$/, T.obj({ ok: T.bool() }))
    expect(project(shape, { github: { ok: true, extra: 1 } })).toEqual({ github: { ok: true } })
    expect(() => project(shape, { 'Bad Key': { ok: true } })).toThrow(ShapeError)
  })
})

describe('T.passthrough（repo/ 四檔的原樣複本）', () => {
  const shape = T.passthrough({ sourceSha: T.str(/^[0-9a-f]{40}$/), generatedAt: T.str(ISO) })

  it('沒列的欄位原樣保留（連巢狀都保留），列出的戳記要過檢查', () => {
    const body = { tickets: [{ id: 'P1', nested: { deep: [1, 'two', null, true] } }], sourceSha: 'a'.repeat(40), generatedAt: '2026-10-12T00:00:00Z' }
    expect(project(shape, body)).toEqual(body)
    expect(() => project(shape, { ...body, sourceSha: 'short' })).toThrow(/sourceSha：/)
    expect(() => project(shape, { ...body, generatedAt: undefined })).toThrow(ShapeError)
  })

  it('太深的巢狀拒絕；非 JSON 值（函式、undefined）拒絕', () => {
    let deep = {}
    const root = deep
    for (let i = 0; i < 40; i++) deep = deep.n = {}
    expect(() => project(shape, { ...root, sourceSha: 'a'.repeat(40), generatedAt: '2026-10-12T00:00:00Z' })).toThrow(ShapeError)
    expect(() => project(shape, { f: () => 1, sourceSha: 'a'.repeat(40), generatedAt: '2026-10-12T00:00:00Z' })).toThrow(ShapeError)
  })
})

describe('serializeChecked：寫檔前兩道把關（白名單投影 → 黑名單掃描）', async () => {
  const { LeakError, serializeChecked } = await import('./lib/files.mjs')
  const at = '2026-10-12T10:15:00.000Z'
  const vm = {
    generatedAt: at,
    deploys: { test: [], prod: [] },
    backups: {
      test: { latest: null, offsiteDir: 'missing', lastRecord: null },
      prod: { latest: { name: 'a.dump', bytes: 1, mtime: at }, offsiteDir: 'ok', lastRecord: { at, ok: true } },
    },
    prodEnv: { site: 'prod', checkedAt: at, missing: [], forbiddenPresent: [], flags: { REGISTRATION_OPEN: 'absent', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'false' } },
    prodEnvError: null,
    prodDns: { host: 'fju.roy422.dev', hasA: true, checkedAt: at },
  }

  it('白名單外的欄位不管在哪一層都不會進輸出（連鍵名沒有提示的值也一樣）', () => {
    const dirty = {
      ...vm,
      leak: 'FAKEPASS601',
      prodEnv: { ...vm.prodEnv, debug: { password: 'FAKEPASS602' }, note: 'FAKEPASS603' },
      backups: { ...vm.backups, prod: { ...vm.backups.prod, latest: { ...vm.backups.prod.latest, path: '/srv/FAKEPASS604' } } },
    }
    const text = serializeChecked('vm.json', dirty)
    expect(text).not.toContain('FAKEPASS')
    expect(JSON.parse(text)).toEqual(vm)
  })

  it('已知欄位值不合樣式：整檔不寫，錯誤帶路徑與黑名單類別、不帶值', () => {
    const gh = {
      generatedAt: at,
      mainSha: 'a'.repeat(40),
      ci: { runId: 1, headSha: 'a'.repeat(40), attempt: 1, status: 'completed', conclusion: 'success', url: 'https://github.com/x/actions/runs/1?token=FAKEPASS605', jobs: [] },
      image: null,
      healthCron: null,
      prs: [],
    }
    let err
    try {
      serializeChecked('github.json', gh)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LeakError)
    expect(err.kinds[0]).toContain('ci.url')
    expect(err.kinds).toContain('連線字串')
    expect(err.message).not.toContain('FAKEPASS')
  })

  it('repo/ 原樣複本：敏感鍵底下的容器有實值就整檔不寫', () => {
    const body = { sourceSha: 'a'.repeat(40), generatedAt: at, tickets: [{ id: 'X', secret: { value: 'FAKEPASS606' } }] }
    expect(() => serializeChecked('repo/tickets.json', body)).toThrow(/敏感欄位/)
    expect(serializeChecked('repo/tickets.json', { ...body, tickets: [{ id: 'X' }] })).toContain('"sourceSha"')
  })

  it('沒定義白名單的檔名不准寫', () => {
    expect(() => serializeChecked('other.json', { generatedAt: at })).toThrow(/白名單/)
  })
})
