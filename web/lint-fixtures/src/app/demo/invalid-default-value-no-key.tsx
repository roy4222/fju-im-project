// 反例（CL-7）：搜尋框的預設值來自網址參數，但欄位與外層都沒有 key——換篩選後舊字留在框裡。
export function DemoSearch({ q }: { q: string }) {
  return (
    <form action="/news" method="get">
      <input name="q" defaultValue={q} />
    </form>
  )
}
