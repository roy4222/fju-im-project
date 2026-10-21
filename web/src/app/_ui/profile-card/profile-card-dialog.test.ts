import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const { length } = await import('./profile-card-dialog')

describe('名片視窗的即時字數（以字計，同伺服器；CL-4）', () => {
  it('emoji、中文各算一個字', () => {
    expect(length('😀前端')).toBe(3)
    expect(length('👍'.repeat(50))).toBe(50)
  })
})
