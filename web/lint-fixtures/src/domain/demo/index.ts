// 模組的公開入口。
export type DemoId = string & { readonly __brand: 'DemoId' }

export function isDemoId(value: string): value is DemoId {
  return value.length > 0
}
