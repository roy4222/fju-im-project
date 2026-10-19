import HomePage from '@/app/page'
import { withFrontEdit } from './with-front-edit'

/** 首頁的編輯版（C2-16）：系辦打 `/` 時由 `proxy.ts` 改寫到這裡，網址列不變。見 `with-front-edit.tsx`。 */
export default async function OfficeEditHome(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withFrontEdit('/', props.searchParams, <HomePage />)
}
