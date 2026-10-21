import { describe, expect, it, vi } from 'vitest'

vi.mock('./actions', () => ({ resetAvatarAction: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const { reasonTooLong } = await import('./avatar-reset-dialog')

describe('重設頭像理由的字數（以字計，同用例的 charLength；CL-4）', () => {
  it('200 個 emoji 可以、201 個擋；中文同理', () => {
    expect(reasonTooLong('😀'.repeat(200))).toBe(false)
    expect(reasonTooLong('😀'.repeat(201))).toBe(true)
    expect(reasonTooLong('字'.repeat(200))).toBe(false)
    expect(reasonTooLong('字'.repeat(201))).toBe(true)
  })
})
