// 合法例（CL-7）：帶資料的預設值有 key；字面值、原樣轉傳 prop、.map 裡外層帶 key 都放行。
export function DemoSearch({ q, rows, defaultValue }: { q: string; rows: { id: string; name: string }[]; defaultValue?: string }) {
  return (
    <div>
      <form key={q} action="/news" method="get">
        <input name="q" defaultValue={q} />
      </form>
      <input name="blank" defaultValue="" />
      <input name="forwarded" defaultValue={defaultValue} />
      {rows.map((r) => (
        <label key={r.id}>
          <input name={`name-${r.id}`} defaultValue={r.name} />
        </label>
      ))}
    </div>
  )
}
