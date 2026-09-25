import { describe, expect, it } from 'vitest'
import { otherWorkbenches, roleSwitchLinks } from '@/app/_ui/role-switch'

describe('兼任角色的後台切換（票 41）', () => {
  it('只有一個角色：什麼都不列', () => {
    expect(roleSwitchLinks(['teacher'], 'teacher')).toEqual([])
    expect(roleSwitchLinks(['admin'], 'admin')).toEqual([])
    expect(roleSwitchLinks(['student'], 'student')).toEqual([])
    // 就算目前所在的後台跟角色對不上（不該發生），單一角色也不列。
    expect(roleSwitchLinks(['teacher'], 'admin')).toEqual([])
  })

  it('沒有角色（待審核）：什麼都不列', () => {
    expect(roleSwitchLinks([], null)).toEqual([])
  })

  it('老師兼系辦：在老師後台只看到「切換到系辦後台」', () => {
    expect(roleSwitchLinks(['teacher', 'admin'], 'teacher')).toEqual([
      { href: '/dashboard/admin', label: '切換到系辦後台', icon: 'switch' },
    ])
  })

  it('老師兼系辦：在系辦後台只看到「切換到老師後台」', () => {
    expect(roleSwitchLinks(['teacher', 'admin'], 'admin')).toEqual([
      { href: '/dashboard/teacher', label: '切換到老師後台', icon: 'switch' },
    ])
  })

  it('三個角色都有：列另外兩個，順序固定系辦、老師、學生', () => {
    expect(roleSwitchLinks(['student', 'teacher', 'admin'], 'teacher').map((l) => l.label)).toEqual(['切換到系辦後台', '切換到學生後台'])
    expect(roleSwitchLinks(['student', 'admin', 'teacher'], 'student').map((l) => l.href)).toEqual(['/dashboard/admin', '/dashboard/teacher'])
  })

  it('前台（以預設後台當目前所在）：列預設以外的後台', () => {
    expect(otherWorkbenches(['teacher', 'admin'], 'admin')).toEqual([{ role: 'teacher', href: '/dashboard/teacher', name: '老師後台' }])
  })

  it('current 為 null：兼任者的每個後台都列出來', () => {
    expect(otherWorkbenches(['admin', 'teacher'], null).map((w) => w.role)).toEqual(['admin', 'teacher'])
  })
})
