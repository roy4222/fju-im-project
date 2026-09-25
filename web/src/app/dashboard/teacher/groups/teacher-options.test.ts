import { describe, expect, it } from 'vitest'
import { teacherFilterOptions } from './teacher-options'

const g = (code: string, id: string | null, name = '') => ({ code, advisor: id ? { teacherUserId: id, teacherName: name } : null })

describe('teacherFilterOptions', () => {
  it('同一位老師指導多組只出現一次；沒有老師的組不算', () => {
    expect(teacherFilterOptions([g('G02', 'u1', '李老師'), g('G01', 'u1', '李老師'), g('G03', null)])).toEqual([{ value: 'u1', label: '李老師' }])
  })

  it('同名的兩位老師：各自一個選項，標籤後面加上指導的組別', () => {
    const options = teacherFilterOptions([g('G05', 'u1', '王老師'), g('G01', 'u1', '王老師'), g('G03', 'u2', '王老師'), g('G04', 'u3', '陳老師')])
    expect(options).toHaveLength(3)
    expect(options.find((o) => o.value === 'u1')!.label).toBe('王老師（G01、G05）')
    expect(options.find((o) => o.value === 'u2')!.label).toBe('王老師（G03）')
    expect(options.find((o) => o.value === 'u3')!.label).toBe('陳老師')
  })
})
