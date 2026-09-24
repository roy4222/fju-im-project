# shellcheck shell=bash
# 備份與還原演練共用的小工具（票 27，2026-09-24）。由 ops/backup.sh、ops/restore-drill.sh
# 用 `. ops/lib/backup-common.sh` 載入，不單獨執行。不讀、不印任何秘密。

# 紀錄檔：一行一筆 JSON、只往後加（ops/lib/backup-record.mjs）。
backup_records_file() { printf '%s/records.jsonl\n' "$1"; }

utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# 抽查用的 SQL：全部資料表的筆數＋回答版本內容的 md5，輸出一行 JSON。
# 備份當下量一次、還原後在演練副本再量一次，兩邊用同一段 SQL，比得起來。
# 用 query_to_xml 做動態查詢，所以還沒建的表（評分、簽核）不會讓整段失敗；
# 之後新增的表也自動列入。只有 SELECT，對來源資料庫是唯讀的。
# shellcheck disable=SC2016,SC2034
SPOT_COUNTS_SQL='
SELECT json_build_object(
  $$tables$$, (
    SELECT coalesce(json_object_agg(t.name, t.n ORDER BY t.name), $${}$$::json)
    FROM (
      SELECT format($$%s.%s$$, table_schema, table_name) AS name,
             (xpath($$/row/c/text()$$, query_to_xml(
               format($$SELECT count(*) AS c FROM %I.%I$$, table_schema, table_name),
               false, true, $$$$)))[1]::text::bigint AS n
      FROM information_schema.tables
      WHERE table_type = $$BASE TABLE$$
        AND table_schema NOT IN ($$pg_catalog$$, $$information_schema$$)
    ) t
  ),
  $$submission_versions_md5$$, CASE
    WHEN to_regclass($$submission_versions$$) IS NULL THEN NULL
    ELSE (xpath($$/row/h/text()$$, query_to_xml(
      $q$SELECT md5(coalesce(string_agg(id::text || $s$:$s$ || md5(answers::text), $s$,$s$ ORDER BY id), $s$$s$)) AS h FROM submission_versions$q$,
      false, true, $$$$)))[1]::text
  END
);'
