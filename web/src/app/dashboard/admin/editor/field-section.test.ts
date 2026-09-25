import { describe, expect, it } from 'vitest'
import { sectionOfField } from './field-section'

describe('sectionOfField（回去補切到哪一段）', () => {
  it('競賽的報名截止日與活動日在內容段', () => {
    expect(sectionOfField('registrationDeadline')).toBe('content')
    expect(sectionOfField('eventDate')).toBe('content')
  })
  it('其他欄位照舊', () => {
    expect(sectionOfField('title')).toBe('content')
    expect(sectionOfField('cover')).toBe('content')
    expect(sectionOfField('fields')).toBe('fields')
    expect(sectionOfField('dueAt')).toBe('publish')
    expect(sectionOfField('groupIds')).toBe('publish')
  })
})
