import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedActor } from '@/application/accounts'

// SEC-2：匯入分組對話框的 `op: 'settings'` 也要先過系辦＋business 狀態守門（原本不檢查身分）。
const state = vi.hoisted(() => ({ actor: { kind: 'anonymous' } as ResolvedActor }))
vi.mock('next/cache', () => ({ refresh: vi.fn() }))
vi.mock('@/app/_ui/guard', () => ({ currentActor: async () => state.actor }))
vi.mock('@/composition/groups', () => ({
  describeGroupImportReceipt: () => '',
  getGroupImportCommand: () => ({}),
  GROUP_IMPORT_KIND_LABEL: { regular: '一般' },
  GROUP_IMPORT_MAX_BYTES: 1024,
  GROUP_IMPORT_OUTCOME_LABEL: { created: '新增' },
  groupImportResultCsv: () => '',
}))

import { groupImportAction } from '@/app/dashboard/admin/groups/import-actions'

function actor(over: Partial<Extract<ResolvedActor, { kind: 'authenticated' }>>): ResolvedActor {
  return { kind: 'authenticated', userId: 'u1', roles: ['admin'], status: 'active', mustChangePassword: false, cohortMemberships: [], ...over }
}

beforeEach(() => vi.clearAllMocks())

describe("groupImportAction op='settings' 守門", () => {
  it.each([
    ['未登入', { kind: 'anonymous' } as ResolvedActor],
    ['學生', actor({ roles: ['student'] })],
    ['必須改密的系辦', actor({ mustChangePassword: true })],
    ['待審的系辦', actor({ status: 'pending' })],
  ])('%s：拒絕（丟錯，對話框顯示連線中斷），不回設定', async (_who, who) => {
    state.actor = who
    await expect(groupImportAction({ op: 'settings' })).rejects.toThrow('只有系辦可以匯入分組。')
  })

  it('有效系辦：拿到文字與上限', async () => {
    state.actor = actor({})
    expect(await groupImportAction({ op: 'settings' })).toEqual({
      kindLabels: { regular: '一般' }, outcomeLabels: { created: '新增' }, maxBytes: 1024,
    })
  })
})
