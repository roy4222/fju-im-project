/**
 * 給 Gatus 與 compose healthcheck 的存活檢查。proxy 唯一不驗 JWT 的路徑，
 * 所以只回固定的 `ok`，不帶任何資料。
 */
export function GET() {
  return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } })
}
