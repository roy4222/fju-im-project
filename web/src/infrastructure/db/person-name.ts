import 'server-only'

/**
 * 畫面上顯示的人名（SQL 片段）：`user_profiles.display_name` 去掉前後空白後有字就用它，否則退回帳號名稱 `users.name`。
 *
 * `display_name` 欄是 NOT NULL，但可能是空字串（或只有空白）；裸 `coalesce(display_name, name)` 會讓空字串原樣出現在
 * 組員名單、歷程與通知標題裡（票 13、票 14 審查建議）。顯示人名的查詢都走這一個，不要各寫各的。
 *
 * `profile`＝`user_profiles` 的別名、`user`＝`users` 的別名（通常是 left join，沒有 profile 時一樣退回帳號名稱）。
 */
export function personName(profile: string, user: string): string {
  return `coalesce(nullif(btrim(${profile}.display_name), ''), ${user}.name)`
}
