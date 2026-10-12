/**
 * 只放 Roy 進來的第二道鎖（設計方案 §3.2）。
 *
 * 第一道是 Cloudflare Access（＋隧道端驗 JWT，§3.2a）；這裡在 status-web 自己再驗一次
 * `Cf-Access-Jwt-Assertion`：簽章對得上 `https://<team>/cdn-cgi/access/certs` 的公鑰、
 * `aud` 等於 ACCESS_AUD、`iss` 等於 `https://<team>`、沒過期。任何一項不符一律拒絕，
 * 所以就算 Access 設錯，自寫頁也不會外洩。
 *
 * 唯一例外是 `/healthz`（只回 `ok`，給 Gatus 與 compose healthcheck）。
 * 略過開關 STATUS_DEV_BYPASS_ACCESS=1 只在 NODE_ENV 不是 production 時有效（本機用 fixtures 開發）。
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion'
export const HEALTHZ_PATH = '/healthz'

/** team 網域只收 `<team>.cloudflareaccess.com`：設錯成別的主機時寧可全擋，也不去別處抓公鑰。 */
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/i

export type AccessEnv = {
  NODE_ENV?: string
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  STATUS_DEV_BYPASS_ACCESS?: string
}

export type AccessConfig = { teamDomain: string; aud: string }

export type AccessDecision =
  | { allow: true; reason: 'healthz' | 'dev-bypass' | 'jwt' }
  | { allow: false; reason: 'not-configured' | 'no-token' | 'invalid-token' }

/** 讀 ACCESS_TEAM_DOMAIN、ACCESS_AUD；缺一個或格式不對就回 null（呼叫端一律拒絕）。 */
export function readAccessConfig(env: AccessEnv): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim() ?? ''
  const aud = env.ACCESS_AUD?.trim() ?? ''
  if (!TEAM_DOMAIN.test(teamDomain) || aud === '') return null
  return { teamDomain: teamDomain.toLowerCase(), aud }
}

export const certsUrl = (teamDomain: string) => new URL(`https://${teamDomain}/cdn-cgi/access/certs`)

/** 驗一個 Access JWT。簽章、aud、iss、exp 任何一項不符都回 false，不丟例外。 */
export async function verifyAccessJwt(
  token: string,
  config: AccessConfig,
  getKey: JWTVerifyGetKey,
): Promise<boolean> {
  try {
    await jwtVerify(token, getKey, {
      audience: config.aud,
      issuer: `https://${config.teamDomain}`,
      // Cloudflare Access 用 RS256 簽；不接受其他演算法（擋 alg 混用）。
      algorithms: ['RS256'],
      requiredClaims: ['exp'],
    })
    return true
  } catch {
    return false
  }
}

/** 公鑰集合依 team 網域快取（jose 自己會處理輪替與冷卻時間）。 */
const remoteKeySets = new Map<string, JWTVerifyGetKey>()
export function remoteKeySet(teamDomain: string): JWTVerifyGetKey {
  let set = remoteKeySets.get(teamDomain)
  if (!set) {
    set = createRemoteJWKSet(certsUrl(teamDomain))
    remoteKeySets.set(teamDomain, set)
  }
  return set
}

/** 一個請求能不能進來。proxy.ts 只是把這個結果變成 403 或放行。 */
export async function decideAccess(input: {
  pathname: string
  token: string | null
  env: AccessEnv
  getKey?: (config: AccessConfig) => JWTVerifyGetKey
}): Promise<AccessDecision> {
  const { pathname, token, env } = input
  if (pathname === HEALTHZ_PATH) return { allow: true, reason: 'healthz' }
  if (env.NODE_ENV !== 'production' && env.STATUS_DEV_BYPASS_ACCESS === '1') {
    return { allow: true, reason: 'dev-bypass' }
  }
  const config = readAccessConfig(env)
  if (!config) return { allow: false, reason: 'not-configured' }
  if (!token) return { allow: false, reason: 'no-token' }
  const getKey = (input.getKey ?? ((c) => remoteKeySet(c.teamDomain)))(config)
  return (await verifyAccessJwt(token, config, getKey))
    ? { allow: true, reason: 'jwt' }
    : { allow: false, reason: 'invalid-token' }
}
