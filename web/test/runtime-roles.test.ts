import { describe, expect, it } from 'vitest'
import { assertLocalTestDatabaseUrl } from './runtime-roles'

describe('assertLocalTestDatabaseUrl（整合測試只准連本機）', () => {
  it('本機與 CI 的連線字串放行', () => {
    expect(() => assertLocalTestDatabaseUrl('postgres://fju_owner:fju_local_dev@127.0.0.1:55432/fju')).not.toThrow()
    expect(() => assertLocalTestDatabaseUrl('postgres://fju_owner:fju_ci@127.0.0.1:5432/fju')).not.toThrow()
    expect(() => assertLocalTestDatabaseUrl('postgresql://u:p@localhost:5432/fju')).not.toThrow()
    expect(() => assertLocalTestDatabaseUrl('postgres://u:p@[::1]:5432/fju')).not.toThrow()
  })

  it('不是本機就拒絕，訊息裡不帶密碼', () => {
    expect(() => assertLocalTestDatabaseUrl('postgres://fju_owner:s3cret@db.example.com:5432/fju')).toThrow(/只准連本機/)
    expect(() => assertLocalTestDatabaseUrl('postgres://fju_owner:s3cret@postgres:5432/fju')).toThrow(/只准連本機/)
    expect(() => assertLocalTestDatabaseUrl('postgres://fju_owner:s3cret@10.0.0.5:5432/fju')).toThrow(/只准連本機/)
    try {
      assertLocalTestDatabaseUrl('postgres://fju_owner:s3cret@db.example.com:5432/fju')
    } catch (error) {
      expect(String(error)).not.toContain('s3cret')
    }
  })

  it('不是 postgres 連線字串、或格式不對也拒絕', () => {
    expect(() => assertLocalTestDatabaseUrl('mysql://u:p@127.0.0.1/fju')).toThrow(/postgres/)
    expect(() => assertLocalTestDatabaseUrl('not a url')).toThrow(/格式不對/)
  })
})
