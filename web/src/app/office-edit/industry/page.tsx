import IndustryPage from '@/app/industry/page'
import { withFrontEdit } from '../with-front-edit'

export { metadata } from '@/app/industry/page'

/** 產學合作的編輯版（C2-16）：系辦打 `/industry` 時由 `proxy.ts` 改寫到這裡。見 `with-front-edit.tsx`。 */
export default async function OfficeEditIndustry(props: Parameters<typeof IndustryPage>[0]) {
  return withFrontEdit('/industry', props.searchParams, <IndustryPage {...props} />)
}
