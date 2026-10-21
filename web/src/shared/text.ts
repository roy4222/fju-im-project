/** 以「字」計（Unicode code point），跟 Postgres 的 `char_length` 一樣；emoji 算一個字。字數上限一律用這個，不用 `.length`。 */
export function charLength(value: string): number {
  return Array.from(value).length
}
