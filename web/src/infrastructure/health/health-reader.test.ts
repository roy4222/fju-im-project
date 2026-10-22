import { describe, expect, it } from 'vitest'
import { buildInfo } from './health-reader'

/**
 * CL-7（#823 第 11 條）：`/api/health` 的版本欄位把空字串當成沒設。
 * Compose 的 `${IMAGE_DIGEST:-}`、照 `.env.example` 留空的 `APP_VERSION=`／`GIT_COMMIT=` 都會給空字串，
 * 之前直接回 `""`，跟沒設時的預設值（`0.0.0`、`unknown`、null）不一樣。
 */
describe('buildInfo：版本欄位', () => {
  it('沒設 → 預設值', () => {
    expect(buildInfo({})).toEqual({ version: '0.0.0', commit: 'unknown', imageDigest: null })
  })

  it('空字串 → 跟沒設一樣', () => {
    expect(buildInfo({ APP_VERSION: '', GIT_COMMIT: '', IMAGE_DIGEST: '' })).toEqual({
      version: '0.0.0',
      commit: 'unknown',
      imageDigest: null,
    })
  })

  it('有值 → 原樣回傳（部署時 deploy.sh 設的 digest 照舊拿來比對）', () => {
    const env = { APP_VERSION: '9.9.9', GIT_COMMIT: 'deadbeef', IMAGE_DIGEST: 'sha256:abc123' }
    expect(buildInfo(env)).toEqual({ version: '9.9.9', commit: 'deadbeef', imageDigest: 'sha256:abc123' })
  })
})
