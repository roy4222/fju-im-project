import RulesPage from '@/app/rules/page'
import { withFrontEdit } from '../with-front-edit'

export { metadata } from '@/app/rules/page'

/** 專題規則的編輯版（C2-16）：系辦打 `/rules` 時由 `proxy.ts` 改寫到這裡。見 `with-front-edit.tsx`。 */
export default async function OfficeEditRules(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return withFrontEdit('/rules', props.searchParams, <RulesPage />)
}
