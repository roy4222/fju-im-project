#!/usr/bin/env bash
# 把這個實例的模擬業務鐘清回真實時間。
#
#   [INSTANCE=n] tools/tutorial/env/clock-reset.sh
#
# 模擬業務鐘的設定是只增不改的帳本（business_clock_overrides），業務時間＝最新一筆的設定時刻＋之後的真實經過時間。
# 「清回真實時間」跟後台「模擬業務鐘」頁做的一樣：補一筆「設定成現在」（business_at＝real_at＝now()），
# 操作者記成教學用的系辦帳號、原因寫明是教學環境。已經是真實時間（沒設定過、或差不到 1 秒）就什麼都不寫。
# reset.sh 灌完資料後也會呼叫它，保證每段錄影都從真實時間開始。
set -euo pipefail
source "$(dirname "$0")/lib.sh"

safety_check
assert_tutorial_db

result="$(dock exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -qAt -U fju_owner -d "$DB_NAME" <<'SQL'
with latest as (
  select business_at, real_at from business_clock_overrides order by real_at desc, id desc limit 1
), office as (
  select user_id from role_assignments where role = 'admin' and revoked_real_at is null order by granted_real_at limit 1
), ins as (
  insert into business_clock_overrides (id, environment, business_at, real_at, previous_business_at, set_by_user_id, reason)
  select gen_random_uuid(), 'staging', now(), now(), latest.business_at + (now() - latest.real_at), office.user_id,
         '教學錄影環境：回到真實時間（clock-reset.sh）'
    from latest, office
   where abs(extract(epoch from (latest.business_at - latest.real_at))) >= 1
  returning previous_business_at
)
select coalesce((select 'reset ' || to_char(previous_business_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') from ins),
                case when not exists (select 1 from latest) then 'none'
                     when not exists (select 1 from office) then 'no-admin'
                     else 'real' end);
SQL
)"
case "$result" in
  reset*) log "模擬業務鐘已清回真實時間（原本是 ${result#reset }）" ;;
  none | real) log "模擬業務鐘本來就是真實時間" ;;
  no-admin) die "找不到系辦帳號可以記成操作者（先跑 up.sh 或 accounts.mjs apply）" ;;
  *) die "清模擬業務鐘失敗：$result" ;;
esac
