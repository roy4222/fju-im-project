// 反例 9：跨模組只能引用公開入口 index.ts，不可以直接指到模組內部檔案。
// 預期被擋：fju/module-boundary
import { parseDemoId } from '../../application/demo/valid-application-uses-domain'

export default function Page() {
  return <p>{String(parseDemoId)}</p>
}
