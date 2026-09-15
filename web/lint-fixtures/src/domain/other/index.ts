// 另一個模組的公開入口，用來測跨模組規則。
export type OtherId = string & { readonly __brand: 'OtherId' }

export function makeOtherId(raw: string): OtherId {
  return raw as OtherId
}
