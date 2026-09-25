#!/usr/bin/env bash
# 故障演練（票 28；SOP 05 監測與告警 v2；模組 10 §4）。**只准對測試站**，要用 deploy 身分跑。
#
#   sudo -u deploy /srv/fju/app/ops/fault-drill.sh --site test <演練> [--execute]
#
#   演練：
#     restart        服務重啟：重啟 app 與 worker，等部署用的完整六項健康判定再次通過
#     worker-stall   背景工作停擺：停掉 worker 超過 5 分鐘，確認 /api/health 變 503；再啟動，確認恢復
#     poison         毒事件：插一件處理不了的到期工作＋一件正常的，確認正常那件照常完成、
#                    毒工作退避到第 5 次標 failed 並發管理員告警
#     disk80         磁碟 80%：在一顆 16 MiB 的記憶體磁碟上塞到 ~88% 再量一次（不碰真的硬碟），
#                    確認量測記成「警戒」、沒有發任何通知；系辦首頁的「儲存與備份」磚會顯示這筆
#     disk80-restore 量一次真的附件目錄，把磚換回實際用量（不做也會在下一個整點自己蓋過去）
#   --execute       真的執行；沒帶就只印步驟
#
# 每次執行（成功或失敗）都在 /srv/fju/test/drills/fault-drills.log 加一行：時間、演練、結果、映像、細節。
# 演練期間拿著測試站的部署鎖：自動部署那一輪會記 busy、下一輪再試，不會跟演練打架。
# 正式站一律拒絕（這支腳本沒有任何參數能對 prod 動手）。
set -euo pipefail

ORIG_ARGS=("$@")
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# `sudo -u deploy` 會沿用呼叫者的目錄（deploy 可能讀不到），先換到自己的目錄。
cd "$APP_ROOT"
# shellcheck source-path=SCRIPTDIR source=lib/site.sh
. "$APP_ROOT/ops/lib/site.sh"

COMPOSE="${COMPOSE:-docker compose}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-120}"
# 背景工作心跳超過 5 分鐘才算停擺（契約 05 §5），多等 30 秒。
WORKER_STALL_WAIT_SECONDS="${WORKER_STALL_WAIT_SECONDS:-330}"
# 毒工作的退避是 2、4、8、16 秒，加上到期迴圈 30 秒一輪，約 2～3 分鐘會到第 5 次。
POISON_TIMEOUT_SECONDS="${POISON_TIMEOUT_SECONDS:-300}"
POLL_SECONDS="${POLL_SECONDS:-10}"

SITE=""
CASE=""
DRY_RUN=1

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) DRY_RUN=0 ;;
    --dry-run) DRY_RUN=1 ;;
    --site)
      [ $# -ge 2 ] || { echo "--site 後面要接 test" >&2; exit 1; }
      SITE="$2"
      shift
      ;;
    --site=*) SITE="${1#--site=}" ;;
    -h|--help) usage 0 ;;
    -*) echo "不認得的選項：$1" >&2; usage 1 ;;
    *)
      if [ -n "$CASE" ]; then echo "一次只能跑一個演練（已經有 ${CASE}）" >&2; exit 1; fi
      CASE="$1"
      ;;
  esac
  shift
done

# 站台守門：只准 test。prod 明講拒絕，不是「沒給就預設 test」。
case "$SITE" in
  test) ;;
  prod) echo "故障演練只准對測試站（--site test）。正式站一律拒絕，什麼都沒做。" >&2; exit 1 ;;
  '') echo "缺少 --site。用法：ops/fault-drill.sh --site test <restart|worker-stall|poison|disk80|disk80-restore> [--execute]" >&2; exit 1 ;;
  *) echo "站台只能是 test（收到：${SITE}）" >&2; exit 1 ;;
esac
case "$CASE" in
  restart|worker-stall|poison|disk80|disk80-restore) ;;
  '') echo "缺少要跑的演練：restart、worker-stall、poison、disk80、disk80-restore" >&2; exit 1 ;;
  *) echo "不認得的演練：${CASE}（只有 restart、worker-stall、poison、disk80、disk80-restore）" >&2; exit 1 ;;
esac

# 真的執行才會動容器、寫 /srv/fju：先擋掉非 deploy 身分。演練（dry-run）任何人都能跑。
if [ "$DRY_RUN" = 0 ]; then
  require_deploy_user "$APP_ROOT/ops/fault-drill.sh ${ORIG_ARGS[*]:-}"
fi

site_setup "$SITE" "$APP_ROOT"

if [ "$DRY_RUN" = 0 ] && [ "${FJU_SECRETS_LOADED:-}" != "$SITE" ]; then
  site_exec_with_secrets bash "$APP_ROOT/ops/fault-drill.sh" "${ORIG_ARGS[@]}"
fi
if [ "$DRY_RUN" = 0 ]; then
  site_verify_secrets
fi

DRILL_DIR="${DRILL_DIR:-$SITE_ROOT/drills}"
DRILL_LOG="$DRILL_DIR/fault-drills.log"
DEPLOY_DIR="${DEPLOY_DIR:-$SITE_ROOT/deploy}"
DRILL_VOLUME="${DRILL_VOLUME:-fju-${SITE}-drill-disk80}"
if [ -n "${HEALTH_URL:-}" ]; then
  HEALTH_CURL_ARGS=()
else
  HEALTH_URL="https://$SITE_HOST/api/health"
  HEALTH_CURL_ARGS=(--resolve "$SITE_HOST:443:127.0.0.1")
fi

say() { printf '[fault-drill] %s\n' "$*"; }
plan() { printf '        $ %s\n' "$*"; }

if [ "$DRY_RUN" = 1 ]; then
  say "演練：${CASE}（站台 ${SITE}，Compose project ${COMPOSE_PROJECT_NAME}）——只印步驟，什麼都不做"
  plan "flock --nonblock $DEPLOY_DIR/deploy.lock   # 演練期間擋住部署"
  plan "export APP_IMAGE=<正在跑的 app 容器的映像> IMAGE_DIGEST=<它的 digest>   # 之後每個 compose 指令都用目前部署的那一版"
  case "$CASE" in
    restart)
      plan "curl -s $HEALTH_URL   # 記下目前的 commit"
      plan "$COMPOSE restart app worker"
      plan "node ops/check-health.mjs   # ${HEALTH_TIMEOUT_SECONDS} 秒內完整六項要通過（commit、worker.version 都是原本那一版）"
      ;;
    worker-stall)
      plan "前置：worker 在跑、60 秒內有心跳"
      plan "$COMPOSE stop worker"
      plan "每 ${POLL_SECONDS} 秒 curl 一次，最多 ${WORKER_STALL_WAIT_SECONDS} 秒：要看到 HTTP 503、ok=false"
      plan "docker start <同一個 worker 容器>   # 不經 compose 的 depends_on（migrate 沒有容器）；任何方式結束都會做這步"
      plan "node ops/check-health.mjs   # ${HEALTH_TIMEOUT_SECONDS} 秒內完整六項要恢復"
      ;;
    poison)
      plan "前置：worker 在跑、60 秒內有心跳，而且 worker 容器的 BUSINESS_CLOCK_OVERRIDE_ENABLED=true；不符就直接判失敗"
      plan "psql：插兩件 test_noop 到期工作（fault_drill_poison 一件、fault_drill_normal 一件，到期時間 2000-01-01）"
      plan "每 ${POLL_SECONDS} 秒查一次，最多 ${POISON_TIMEOUT_SECONDS} 秒：正常那件 done；毒工作 attempts 到 5、state=failed、有一筆 ops.worker_alert"
      ;;
    disk80)
      plan "docker volume create --opt type=tmpfs --opt o=size=16m,uid=1001 $DRILL_VOLUME"
      plan "$COMPOSE run --rm --no-deps --pull never -v $DRILL_VOLUME:/drill-disk worker sh -c 'dd 14 MiB 到 /drill-disk && node migrate/web/dist/worker.mjs --measure-storage-once --path /drill-disk --drill'"
      plan "psql：最新一筆量測要是 alert_level=warn80、drill=true；演練期間沒有任何跟磁碟有關的事件（＝不會有通知）"
      plan "docker volume rm $DRILL_VOLUME"
      ;;
    disk80-restore)
      plan "$COMPOSE exec -T worker node migrate/web/dist/worker.mjs --measure-storage-once"
      ;;
  esac
  plan "echo '<時間>\t${CASE}\t<pass|fail>\t<映像>\t<細節>' >> $DRILL_LOG"
  say "這是演練，什麼都沒有執行。要真的跑請加 --execute（在 VM 上以 deploy 身分執行）。"
  exit 0
fi

# ── 以下是真的執行 ─────────────────────────────────────────

mkdir -p "$DRILL_DIR" "$DEPLOY_DIR"
exec 9>"$DEPLOY_DIR/deploy.lock"
if ! flock --nonblock 9; then
  echo "拿不到部署鎖（有部署正在跑），這次不演練。" >&2
  exit 75
fi

STARTED="$(date +%s)"
IMAGE=""
RECORDED=0
# 結束時要收拾的東西（on_exit 看這兩個）：
STALLED_WORKER_CID=""   # worker-stall 停掉的 worker 容器；還沒確認帶回來之前一直有值
DRILL_VOLUME_CREATED=0  # disk80 建的記憶體磁碟

record() {
  local result="$1" detail="$2"
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$CASE" "$result" "${IMAGE:-unknown}" "$detail" >> "$DRILL_LOG"
  RECORDED=1
}
pass() {
  record pass "$1（$(( $(date +%s) - STARTED )) 秒）"
  say "✓ 通過：$1"
  say "紀錄已寫入 $DRILL_LOG"
  exit 0
}
fail() {
  record fail "$1"
  say "✗ 不通過：$1" >&2
  say "紀錄已寫入 $DRILL_LOG" >&2
  exit 1
}

# 容器環境變數裡某一個鍵的值（只取那一個，不印其他的；容器環境裡有秘密）。
container_env() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | sed -n "s/^$2=//p" | head -1
}

# 把停掉的 worker 帶回來：直接 `docker start` 同一個容器。
# 不用 `docker compose start／up worker`：worker 在 Compose 裡依賴 migrate，而 deploy.sh 的 migrate 是
# `run --rm` 跑的、沒有留下容器，Compose 會回「worker is missing dependency migrate」（VM 第一次實跑就卡在這）。
# 同一個容器不存在了才退回 `up -d --no-deps`，而且用目前部署的映像、不 build、不 pull。
bring_worker_back() {
  local cid="$1"
  [ -n "$cid" ] || return 1
  [ "$(docker inspect --format '{{.State.Running}}' "$cid" 2>/dev/null)" = true ] && return 0
  docker start "$cid" >/dev/null 2>&1 && return 0
  $COMPOSE up -d --no-deps --no-build --pull never worker >/dev/null 2>&1
}

# 任何方式結束（成功、失敗、set -e 中斷、Ctrl-C）都會走這裡：
#   1. worker-stall 停掉的 worker 一定帶回來；
#   2. disk80 的記憶體磁碟一定刪掉；
#   3. 還沒寫紀錄就中途結束的，補一筆 fail（VM 第一次實跑時 worker-stall 就是這樣什麼都沒留下）。
# shellcheck disable=SC2329  # 由下面的 trap 呼叫。
on_exit() {
  local rc=$? note=""
  set +e
  if [ -n "$STALLED_WORKER_CID" ]; then
    if bring_worker_back "$STALLED_WORKER_CID"; then
      note="；worker 已重新啟動"
    else
      note="；⚠️ worker 沒能重新啟動，請手動：sudo -u ${FJU_DEPLOY_USER} docker start ${STALLED_WORKER_CID}"
    fi
    say "${note#；}" >&2
  fi
  if [ "$DRILL_VOLUME_CREATED" = 1 ]; then
    docker volume rm -f "$DRILL_VOLUME" >/dev/null 2>&1
  fi
  if [ "$RECORDED" != 1 ]; then
    record fail "腳本中途結束（結束碼 ${rc}）${note}"
    say "✗ 腳本中途結束（結束碼 ${rc}）${note}。紀錄已寫入 $DRILL_LOG" >&2
    [ "$rc" = 0 ] && rc=1
  fi
  rm -f "$HEALTH_BODY"
  exit "$rc"
}
HEALTH_BODY="$(mktemp)"
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# /api/health：印 HTTP 狀態碼到 stdout，內容寫到 ${HEALTH_BODY}。
health_code() {
  curl -s --max-time 5 -o "$HEALTH_BODY" -w '%{http_code}' ${HEALTH_CURL_ARGS[@]+"${HEALTH_CURL_ARGS[@]}"} "$HEALTH_URL" || true
}
health_json() { cat "$HEALTH_BODY"; }
json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))}catch{}})' "$1"; }

# 心跳（worker.lastTickAt）是不是晚於某個時間點（epoch 秒）。
tick_after() {
  local since="$1" at
  at="$(health_json | json_field worker.lastTickAt)"
  [ -n "$at" ] && node -e 'process.exit(Date.parse(process.argv[1]) > Number(process.argv[2]) * 1000 ? 0 : 1)' "$at" "$since"
}

# 部署用的完整六項判定（ops/check-health.mjs），等到通過或逾時。
# 第二個參數（epoch 秒，可省略）：心跳還要晚於這個時間點才算數。
await_full_health() {
  local tag="$1" since="${2:-0}" deadline
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$(health_code)" = 200 ] && HEALTH_JSON="$(health_json)" EXPECT_TAG="$tag" EXPECT_WORKER=1 \
      node "$APP_ROOT/ops/check-health.mjs" >/dev/null 2>&1 && tick_after "$since"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# 在 postgres 容器裡用 owner 跑 SQL（SQL 從 stdin 進去；-At：只印值、用 | 分欄）。
psql_owner() {
  # shellcheck disable=SC2016  # ${POSTGRES_USER}／${POSTGRES_DB} 要在容器裡展開。
  $COMPOSE exec -T postgres sh -c 'psql -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

# 對的 Compose project 裡真的有站台在跑，才演練（避免對著空的 project 重啟、誤判通過）。
APP_CID="$($COMPOSE ps -q app 2>/dev/null | head -1 || true)"
[ -n "$APP_CID" ] || fail "Compose project ${COMPOSE_PROJECT_NAME} 裡沒有在跑的 app，先確認站台是起來的"
# 目前部署的映像與 digest：從正在跑的 app 容器讀，export 給之後每一個 docker compose 指令。
# 不設的話 Compose 會退回 docker-compose.yml 的預設 `ghcr.io/roy4222/fju-web:local` 並試著 build
# （VM 上沒有原始碼，disk80 第一次實跑就是 `lstat /srv/fju/app/web: no such file or directory`）。
IMAGE="$(docker inspect --format '{{.Config.Image}}' "$APP_CID" 2>/dev/null || true)"
[ -n "$IMAGE" ] || fail "讀不出 app 容器（${APP_CID}）的映像"
APP_IMAGE="$IMAGE"
IMAGE_DIGEST="$(container_env "$APP_CID" IMAGE_DIGEST)"
export APP_IMAGE IMAGE_DIGEST
WORKER_CID="$($COMPOSE ps -q worker 2>/dev/null | head -1 || true)"
say "目前部署的映像：${IMAGE}"

# 背景工作在跑、而且 60 秒內有心跳；不是就直接判「前置不符」，不要白等。
require_fresh_worker() {
  local hint="先恢復 worker：sudo -u ${FJU_DEPLOY_USER} docker start fju-${SITE}-worker（或重跑一次部署），確認 /api/health 的 worker.lastTickAt 是幾秒內再演練"
  [ -n "$WORKER_CID" ] || fail "前置不符：worker 沒有在跑。${hint}"
  [ "$(health_code)" = 200 ] || fail "前置不符：/api/health 不是 200（$(health_json)）。${hint}"
  tick_after "$(( $(date +%s) - 60 ))" \
    || fail "前置不符：worker 心跳不新鮮（worker.lastTickAt=$(health_json | json_field worker.lastTickAt)）。${hint}"
}

case "$CASE" in
  restart)
    [ "$(health_code)" = 200 ] || fail "演練前 /api/health 就不是 200，先把站台修好再演練"
    tag="$(health_json | json_field commit)"
    say "演練前：commit ${tag}，健康。重啟 app 與 worker……"
    restarted_at="$(date +%s)"
    $COMPOSE restart app worker
    # 心跳要晚於「重啟那一刻」：證明是重啟後的新 worker 在跳，不是重啟前留下的那一拍。
    if await_full_health "$tag" "$restarted_at"; then
      pass "重啟後 ${HEALTH_TIMEOUT_SECONDS} 秒內完整六項通過、心跳來自重啟後的 worker，commit 與 worker.version 仍是 ${tag}"
    fi
    fail "重啟後 ${HEALTH_TIMEOUT_SECONDS} 秒內完整六項沒有通過：$(health_json)"
    ;;

  worker-stall)
    require_fresh_worker
    tag="$(health_json | json_field commit)"
    say "停掉 worker（${WORKER_CID:0:12}），最多等 ${WORKER_STALL_WAIT_SECONDS} 秒看 /api/health 變 503……"
    # 先記下來再停：從這一刻起，不管怎麼結束，on_exit 都會把它帶回來。
    STALLED_WORKER_CID="$WORKER_CID"
    $COMPOSE stop worker
    stopped_at="$(date +%s)"
    saw_503=""
    while [ $(( $(date +%s) - stopped_at )) -lt "$WORKER_STALL_WAIT_SECONDS" ]; do
      if [ "$(health_code)" = 503 ] && [ "$(health_json | json_field ok)" = false ]; then
        saw_503="$(( $(date +%s) - stopped_at ))"
        break
      fi
      sleep "$POLL_SECONDS"
    done
    say "重新啟動 worker（docker start 同一個容器）……"
    bring_worker_back "$WORKER_CID" || fail "worker 重新啟動失敗（on_exit 會再試一次）"
    STALLED_WORKER_CID=""
    [ -n "$saw_503" ] || fail "worker 停了 ${WORKER_STALL_WAIT_SECONDS} 秒，/api/health 還沒變 503（worker 已重新啟動）"
    say "停掉 ${saw_503} 秒後 /api/health 回 503、ok=false"
    if await_full_health "$tag"; then
      pass "worker 停掉 ${saw_503} 秒後 /api/health 回 503；重新啟動後完整六項恢復通過"
    fi
    fail "worker 重新啟動後 ${HEALTH_TIMEOUT_SECONDS} 秒內沒有恢復：$(health_json)"
    ;;

  poison)
    # 前置：worker 在跑、心跳新鮮，而且 test_noop 有處理器（只在 BUSINESS_CLOCK_OVERRIDE_ENABLED=true 時註冊）。
    # 讀的是 **worker 容器實際拿到的值**，不是這支腳本自己的環境。
    require_fresh_worker
    clock_override="$(container_env "$WORKER_CID" BUSINESS_CLOCK_OVERRIDE_ENABLED)"
    [ "$clock_override" = true ] \
      || fail "前置不符：worker 容器的 BUSINESS_CLOCK_OVERRIDE_ENABLED 是「${clock_override:-沒設}」，不是 true，test_noop 沒有處理器、毒工作不會被撿（測試站 Doppler stg 應該是 true）"
    # 到期時間用 2000-01-01：不管測試站的模擬業務鐘撥到哪天都已經到期。
    ids="$(psql_owner <<'SQL'
insert into due_work (id, kind, subject_type, subject_id, deadline_version, due_business_at)
values (gen_random_uuid(), 'test_noop', 'fault_drill_poison', gen_random_uuid(), 1, '2000-01-01T00:00:00Z'),
       (gen_random_uuid(), 'test_noop', 'fault_drill_normal', gen_random_uuid(), 1, '2000-01-01T00:00:00Z')
returning subject_type || ':' || id;
SQL
)"
    poison_id="$(printf '%s\n' "$ids" | sed -n 's/^fault_drill_poison://p')"
    normal_id="$(printf '%s\n' "$ids" | sed -n 's/^fault_drill_normal://p')"
    [ -n "$poison_id" ] && [ -n "$normal_id" ] || fail "插不進到期工作：$ids"
    say "毒工作 ${poison_id}、正常工作 ${normal_id}；最多等 ${POISON_TIMEOUT_SECONDS} 秒……"
    deadline=$(( $(date +%s) + POISON_TIMEOUT_SECONDS ))
    normal_done_at=""
    while [ "$(date +%s)" -lt "$deadline" ]; do
      row="$(printf "select (select state from due_work where id = '%s'), (select state || ',' || attempts from due_work where id = '%s'), (select count(*) from domain_events where type = 'ops.worker_alert' and source_id = '%s');\n" \
        "$normal_id" "$poison_id" "$poison_id" | psql_owner)"
      IFS='|' read -r normal_state poison_state alerts <<< "$row"
      say "  正常：${normal_state}；毒工作：${poison_state}（state,attempts）；告警 ${alerts} 筆"
      if [ "$normal_state" = "done" ] && [ -z "$normal_done_at" ]; then normal_done_at="$(( $(date +%s) - STARTED ))"; fi
      if [ "$normal_state" = "done" ] && [ "$poison_state" = failed,5 ] && [ "$alerts" = 1 ]; then
        pass "正常工作 ${normal_done_at} 秒內完成；毒工作退避到第 5 次標 failed，管理員告警 1 筆（毒 ${poison_id}）"
      fi
      if [ "${poison_state%%,*}" = "done" ]; then
        fail "毒工作被當成正常做完了：這個映像的 test_noop 還不認得 fault_drill_poison（票 28 之前的版本？）"
      fi
      sleep "$POLL_SECONDS"
    done
    if [ "$normal_state" = pending ] && [ "$poison_state" = pending,0 ]; then
      fail "${POISON_TIMEOUT_SECONDS} 秒內兩件都沒被撿（都還是 pending、attempts 0）：worker 的到期迴圈沒在跑。看 log：sudo -u ${FJU_DEPLOY_USER} $APP_ROOT/ops/site.sh test docker compose logs --tail 100 worker"
    fi
    fail "${POISON_TIMEOUT_SECONDS} 秒內沒有收斂：正常 ${normal_state:-?}、毒工作 ${poison_state:-?}、告警 ${alerts:-?} 筆"
    ;;

  disk80)
    # 「不推播」怎麼驗：站內通知一定是從事件投影來的，所以看演練期間有沒有跟磁碟有關的事件。
    # 不直接數通知：前一個演練（poison）的告警可能剛好在這幾秒內投影成通知，會誤判。
    since="$(printf 'select now();\n' | psql_owner)"
    docker volume rm -f "$DRILL_VOLUME" >/dev/null 2>&1 || true
    # 16 MiB 的記憶體磁碟，擁有者是容器裡的 nextjs（1001）；演練完就刪，真的硬碟一個位元組都不寫。
    DRILL_VOLUME_CREATED=1
    docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=16m,uid=1001 "$DRILL_VOLUME" >/dev/null
    say "在 16 MiB 的記憶體磁碟塞 14 MiB，再用目前部署的映像量一次……"
    # --pull never：只用本機已經有的那個映像（就是 app 正在跑的那個），不拉、也不會退回去 build。
    out="$($COMPOSE run --rm --no-deps --pull never -v "$DRILL_VOLUME:/drill-disk" worker \
      sh -c 'dd if=/dev/zero of=/drill-disk/fill bs=1048576 count=14 2>/dev/null; node migrate/web/dist/worker.mjs --measure-storage-once --path /drill-disk --drill' 2>&1)" \
      || fail "量測指令失敗：$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
    printf '%s\n' "$out" | grep STORAGE_MEASURED || true
    latest="$(printf "select payload->>'used_percent', payload->>'alert_level', payload->>'drill' from audit_events where action = 'storage.measured' order by real_at desc, id desc limit 1;\n" | psql_owner)"
    IFS='|' read -r used level drill <<< "$latest"
    storage_events="$(printf "select count(*) from domain_events where occurred_real_at >= '%s' and (type ilike '%%storage%%' or type ilike '%%disk%%' or source_type = 'storage' or payload::text ilike '%%storage%%');\n" "$since" | psql_owner)"
    [ "$level" = warn80 ] || [ "$level" = critical ] || fail "最新量測是 ${used}%／${level}，不是警戒"
    [ "$drill" = true ] || fail "最新量測不是演練寫的那一筆（${latest}）"
    [ "$storage_events" = 0 ] || fail "量到 ${used}% 時發了 ${storage_events} 個跟磁碟有關的事件（會變成通知），違反「不推播」"
    say "現在打開 https://$SITE_HOST/dashboard/admin ：「儲存與備份」磚應該是 ${used}%、說明第一段「警戒（≥80%）」、最後標「（故障演練）」。"
    say "看完跑：sudo -u ${FJU_DEPLOY_USER} $APP_ROOT/ops/fault-drill.sh --site test disk80-restore --execute（不跑的話下一個整點也會自己蓋過去）"
    pass "量到 ${used}%，記成 ${level}（演練），沒有發任何跟磁碟有關的事件／通知"
    ;;

  disk80-restore)
    [ -n "$WORKER_CID" ] || fail "worker 沒有在跑，量不了；先恢復 worker"
    out="$($COMPOSE exec -T worker node migrate/web/dist/worker.mjs --measure-storage-once 2>&1)" \
      || fail "量測指令失敗：$(printf '%s' "$out" | tail -3 | tr '\n' ' ')"
    line="$(printf '%s\n' "$out" | grep STORAGE_MEASURED || true)"
    say "${line:-$out}"
    pass "已量一次真的附件目錄：${line#STORAGE_MEASURED }"
    ;;
esac
