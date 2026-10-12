// AC-S-1、AC-S-2、AC-S-3：只放 Roy 進來的第二道鎖。
// 用本地產的 RSA 金鑰簽 JWT，公鑰由一個本機的假 JWKS 端點提供（真的走 HTTP 抓公鑰）。
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose'
import { NextRequest } from 'next/server'

import { decideAccess, readAccessConfig, verifyAccessJwt, type AccessEnv } from './access'

const TEAM = 'roy-test.cloudflareaccess.com'
const AUD = 'aud-tag-for-tests'
const env: AccessEnv = { NODE_ENV: 'production', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }

let server: Server
let jwksUrl: URL
let goodKey: CryptoKey
let otherKey: CryptoKey

beforeAll(async () => {
  const good = await generateKeyPair('RS256')
  const other = await generateKeyPair('RS256')
  goodKey = good.privateKey
  otherKey = other.privateKey
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  jwksUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/cdn-cgi/access/certs`)
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const getKey = () => createRemoteJWKSet(jwksUrl)

async function sign(opts: { aud?: string; iss?: string; exp?: number | string; key?: CryptoKey } = {}) {
  return new SignJWT({ email: 'roy@example.invalid' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setAudience(opts.aud ?? AUD)
    .setIssuer(opts.iss ?? `https://${TEAM}`)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? goodKey)
}

describe('readAccessConfig', () => {
  it('缺 AUD、缺 team、team 不是 cloudflareaccess.com 都視為沒設定', () => {
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM })).toBeNull()
    expect(readAccessConfig({ ACCESS_AUD: AUD })).toBeNull()
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: 'evil.example.com', ACCESS_AUD: AUD })).toBeNull()
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: `https://${TEAM}`, ACCESS_AUD: AUD })).toBeNull()
    expect(readAccessConfig(env)).toEqual({ teamDomain: TEAM, aud: AUD })
  })
})

describe('AC-S-2：五種 JWT 只有正確那個放行', () => {
  const config = { teamDomain: TEAM, aud: AUD }
  it('正確 JWT → 放行', async () => {
    expect(await verifyAccessJwt(await sign(), config, getKey())).toBe(true)
    expect(await decideAccess({ pathname: '/', token: await sign(), env, getKey })).toEqual({ allow: true, reason: 'jwt' })
  })
  it('aud 錯 → 拒絕', async () => {
    expect(await verifyAccessJwt(await sign({ aud: 'someone-else' }), config, getKey())).toBe(false)
  })
  it('iss 錯 → 拒絕', async () => {
    expect(await verifyAccessJwt(await sign({ iss: 'https://other.cloudflareaccess.com' }), config, getKey())).toBe(false)
  })
  it('過期 → 拒絕', async () => {
    const past = Math.floor(Date.now() / 1000) - 600
    expect(await verifyAccessJwt(await sign({ exp: past }), config, getKey())).toBe(false)
  })
  it('簽章錯（別把鑰匙簽的）→ 拒絕', async () => {
    expect(await verifyAccessJwt(await sign({ key: otherKey }), config, getKey())).toBe(false)
  })
  it('亂碼 token → 拒絕', async () => {
    expect(await verifyAccessJwt('not-a-jwt', config, getKey())).toBe(false)
  })
})

describe('decideAccess', () => {
  it('/healthz 不需要 JWT', async () => {
    expect(await decideAccess({ pathname: '/healthz', token: null, env: {} })).toEqual({ allow: true, reason: 'healthz' })
  })
  it('AC-S-3：production 下略過開關無效', async () => {
    const d = await decideAccess({ pathname: '/', token: null, env: { ...env, STATUS_DEV_BYPASS_ACCESS: '1' } })
    expect(d.allow).toBe(false)
  })
  it('非 production 且開關為 1 才略過', async () => {
    const d = await decideAccess({ pathname: '/', token: null, env: { NODE_ENV: 'development', STATUS_DEV_BYPASS_ACCESS: '1' } })
    expect(d).toEqual({ allow: true, reason: 'dev-bypass' })
  })
  it('沒設定 team／AUD 時，就算帶了合法 JWT 也拒絕', async () => {
    const d = await decideAccess({ pathname: '/', token: await sign(), env: { NODE_ENV: 'production' }, getKey })
    expect(d).toEqual({ allow: false, reason: 'not-configured' })
  })
})

describe('AC-S-1、AC-S-3：proxy 對每條路徑的回應', () => {
  async function callProxy(path: string, headers: Record<string, string> = {}) {
    vi.resetModules()
    const { proxy } = await import('@/proxy')
    return proxy(new NextRequest(new URL(path, 'http://status.local'), { headers }))
  }

  const paths = ['/', '/map', '/progress', '/go-live', '/shots/x/y/screenshots/z.png', '/_next/static/x.js']

  it('production、不帶 JWT：六條路徑全部 403 且內文不含資料', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ACCESS_TEAM_DOMAIN', TEAM)
    vi.stubEnv('ACCESS_AUD', AUD)
    try {
      for (const p of paths) {
        const res = await callProxy(p)
        expect(res.status, p).toBe(403)
        expect(await res.text(), p).toBe('Forbidden')
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('production 且 STATUS_DEV_BYPASS_ACCESS=1：仍是 403', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ACCESS_TEAM_DOMAIN', TEAM)
    vi.stubEnv('ACCESS_AUD', AUD)
    vi.stubEnv('STATUS_DEV_BYPASS_ACCESS', '1')
    try {
      expect((await callProxy('/')).status).toBe(403)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('/healthz 放行（交給 route 回 ok）', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const res = await callProxy('/healthz')
      expect(res.status).toBe(200)
      expect(res.headers.get('x-middleware-next')).toBe('1')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('proxy 沒有設 matcher（每個請求都經過，含 /_next/*）', async () => {
    const mod = (await import('@/proxy')) as Record<string, unknown>
    expect(mod.config).toBeUndefined()
  })
})
