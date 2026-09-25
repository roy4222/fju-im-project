import { describe, expect, it } from 'vitest'
import { badgeFor, badgeMap, roleOfBase } from '@/app/_ui/nav-badge-rules'

const counts = {
  unread: 3,
  studentPending: 2,
  studentSignoff: 1,
  teacherToGrade: 4,
  teacherSignoff: 1,
  adminPendingApplications: 5,
}

describe('側欄徽章規則（原型 badgeFor）', () => {
  it('學生：通知、作業區、簽核各自的數字；其他項目沒有徽章', () => {
    const hrefs = ['/dashboard/student', '/dashboard/student/inbox', '/dashboard/student/affairs', '/dashboard/student/groups', '/dashboard/student/signoff']
    expect(badgeMap('student', hrefs, counts)).toEqual({
      '/dashboard/student/inbox': 3,
      '/dashboard/student/affairs': 2,
      '/dashboard/student/signoff': 1,
    })
  })

  it('老師：通知、評分、簽核；系辦：通知、帳號', () => {
    expect(badgeFor('teacher', '/dashboard/teacher/grading', counts)).toBe(4)
    expect(badgeFor('teacher', '/dashboard/teacher/signoff', counts)).toBe(1)
    expect(badgeFor('teacher', '/dashboard/teacher/affairs', counts)).toBeUndefined()
    expect(badgeFor('admin', '/dashboard/admin/accounts', counts)).toBe(5)
    expect(badgeFor('admin', '/dashboard/admin/inbox', counts)).toBe(3)
    expect(badgeFor('admin', '/dashboard/admin/signoff', counts)).toBeUndefined()
  })

  it('別的角色的數字不會出現在這個角色的側欄（學生的待繳不會掛到老師的「各組繳交」）', () => {
    expect(badgeFor('teacher', '/dashboard/teacher/affairs', { studentPending: 9 })).toBeUndefined()
    expect(badgeFor('student', '/dashboard/student/grading', { teacherToGrade: 9 })).toBeUndefined()
    expect(badgeFor('admin', '/dashboard/admin/accounts', { studentPending: 9 })).toBeUndefined()
  })

  it('0、讀不到（undefined）都不顯示', () => {
    expect(badgeFor('student', '/dashboard/student/affairs', { studentPending: 0 })).toBeUndefined()
    expect(badgeFor('student', '/dashboard/student/inbox', {})).toBeUndefined()
    expect(badgeMap('admin', ['/dashboard/admin/accounts', '/dashboard/admin/inbox'], { unread: 0, adminPendingApplications: 0 })).toEqual({})
  })

  it('網址前綴對角色；不是三種後台就沒有徽章', () => {
    expect(roleOfBase('/dashboard/admin')).toBe('admin')
    expect(roleOfBase('/dashboard/teacher')).toBe('teacher')
    expect(roleOfBase('/dashboard/student')).toBe('student')
    expect(roleOfBase('/account')).toBeNull()
  })
})
