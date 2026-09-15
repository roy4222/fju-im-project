import 'server-only'
// 反例 13：infrastructure 實作 port 時可以拿執行期的東西，
// 但仍然只能經模組的公開入口，不可以直接指到內部檔案（母 spec §4.3）。
// 預期被擋：fju/module-boundary
import { parseDemoId } from '../application/demo/valid-application-uses-domain'

export const parse = parseDemoId
