import FilesPage from '@/app/files/page'
import { withFrontEdit } from '../with-front-edit'

export { metadata } from '@/app/files/page'

/** 檔案下載的編輯版（C2-16）：系辦打 `/files` 時由 `proxy.ts` 改寫到這裡。見 `with-front-edit.tsx`。 */
export default async function OfficeEditFiles(props: Parameters<typeof FilesPage>[0]) {
  return withFrontEdit('/files', props.searchParams, <FilesPage {...props} />)
}
