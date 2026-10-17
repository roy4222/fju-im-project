import 'server-only'
/**
 * 頭像網址（SH-8）：`UserAvatar` 用它算 `<img src>`。
 * 純函式，從模組入口 re-export；app 只從 composition 拿執行期值。
 */
export { avatarUrl } from '@/application/accounts'
