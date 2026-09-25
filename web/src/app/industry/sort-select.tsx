'use client'

/**
 * 排序下拉（原型 `/industry`：改了就套用，不用再按鈕）。
 *
 * 只是幫忙送出所在的 GET 表單；排序本身仍由伺服器依網址算。沒有 JavaScript 時
 * 在搜尋框按 Enter 一樣會連同排序一起送出。
 */
export function SortSelect({ id, defaultValue, options }: { id: string; defaultValue: string; options: readonly (readonly [string, string])[] }) {
  return (
    <>
      <label htmlFor={id} className="sr-only">
        排序方式
      </label>
      <select
        id={id}
        name="sort"
        defaultValue={defaultValue}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-10 rounded-md border border-input bg-background px-2.5 text-sm font-semibold outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary/20"
      >
        {options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </>
  )
}
