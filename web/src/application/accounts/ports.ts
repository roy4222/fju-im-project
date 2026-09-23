import type { ResolvedActor } from '@/application/accounts/actor'

/**
 * 模組 01 對外提供的 port（模組 01 §5）。
 *
 * 實作在 infrastructure，實例由 composition 注入——用例只看得到這個介面。
 */
export interface ActorResolver {
  /** 從這次請求的 headers（cookie 在裡面）算出現在是誰。 */
  resolve(headers: Headers): Promise<ResolvedActor>
}
