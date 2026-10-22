import 'server-only'

/**
 * 一個人的頭像兩欄（SQL 片段；C3 設計方案 §2.2）：展開成 `<profile>.avatar_preset, <profile>.avatar_file_id`。
 *
 * 回傳「人」的列表查詢本來就 join `user_profiles`（姓名從那裡來，見 `personName`），同一句多選這兩欄，查詢數不變。
 * 刻意不做「依 userId 再查一次頭像」的 helper，避免有人拿它寫出 N+1。
 *
 * `profile`＝`user_profiles` 的別名（通常是 left join，沒有 profile 時兩欄都是 null，`avatarUrl` 依帳號 hash 固定一張）。
 */
export function personAvatar(profile: string): string {
  return `${profile}.avatar_preset, ${profile}.avatar_file_id`
}
