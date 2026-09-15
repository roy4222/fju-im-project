import { getHealthSnapshot } from '@/composition/health'

// 健康狀態每次都要重算：這是「現在這個容器連到的資料庫是什麼狀態」，不能快取。
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(): Promise<Response> {
  const snapshot = await getHealthSnapshot()
  return Response.json(snapshot, {
    status: snapshot.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  })
}
