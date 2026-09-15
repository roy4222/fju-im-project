// 反例 11：`export … from` 一樣會把別的模組的執行期實作接出去，
// 只檢查 import 等於留一個後門。
// 預期被擋：fju/module-boundary
export { isDemoId } from '../../domain/demo'
