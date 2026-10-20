import PrivacyPage from '@/app/privacy/page'
import { withFrontEdit } from '../with-front-edit'

export { metadata } from '@/app/privacy/page'

/** 隱私權政策的編輯版（C2-16）：系辦打 `/privacy` 時由 `proxy.ts` 改寫到這裡。見 `with-front-edit.tsx`。 */
export default async function OfficeEditPrivacy(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withFrontEdit('/privacy', props.searchParams, <PrivacyPage />)
}
