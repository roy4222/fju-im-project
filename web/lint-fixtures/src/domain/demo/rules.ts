// 模組內部檔案：別的模組不可以直接指到這裡（母 spec §4.3 公開入口）。
export function internalRule(value: string): boolean {
  return value.length > 3
}
