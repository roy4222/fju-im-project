// 每個輸出檔的白名單（設計方案 §3.3 與 S-1 的 src/lib/data/types.ts，加上 collector 自己補的欄位：
// github 的 fetchedAt／apiCalls／fetchErrorAt、ci.attempt；health 的 gatusOk／error；vm 的 offsiteDir／prodEnvError／prodDns；
// acceptance-index 的 requiredItems）。寫檔前 files.mjs 用這裡的形狀投影：不在清單的欄位一律不輸出，值不合樣式就整檔不寫。
import { T } from './shape.mjs'

export const SHA40 = /^[0-9a-f]{40}$/
/** ISO 8601：collector 的 toISOString、GitHub 的 Z、acceptance-night.sh 的 +0800、Gatus 的奈秒都收。 */
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/
const WORD = /^[A-Za-z0-9_-]{1,64}$/
const ID = /^[A-Za-z0-9._-]{1,128}$/
/** 環境變數鍵名（envcheck 只輸出鍵名）。 */
const KEY_NAME = /^[A-Z][A-Z0-9_]{0,127}$/
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/
const COMMIT = /^[0-9A-Za-z._-]{1,64}$/
/** GitHub 頁面網址：不允許 ?、#、@ 與第二個冒號 → 沒有 query、沒有 userinfo。 */
const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9._~/-]+$/
/** Access 登入網址只留 origin＋路徑（health.mjs 切掉 query）。 */
const ORIGIN_PATH = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/
/** deploy_log 的 tag 欄：docker tag、映像參照（ghcr.io/x/web:tag）或 no-previous。 */
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,200}$/
const DIGEST = /^sha256:[A-Za-z0-9]{1,64}$/
const EVENT = /^[a-z0-9-]{1,40}$/
/** git 分支名：不能有空白與 ~ ^ : ? * [ ] \ 以及引號、角括號。 */
const BRANCH = /^[^\s~^:?*[\]\\'"<>]{1,255}$/
/** 備份檔名：只排除控制字元與引號、角括號、直線（內容交給黑名單）。 */
const FILE_NAME = /^[^\p{Cc}"'<>|]{1,255}$/u
/** 自由文字（錯誤訊息、原因）：沒有樣式，只限長度；內容交給第二道黑名單。 */
const text = (max) => T.str(null, max)

const stamp = { generatedAt: T.str(ISO) }

const run = T.nullable(
  T.obj({
    runId: T.int(),
    headSha: T.str(SHA40),
    attempt: T.optional(T.nullable(T.int())),
    status: T.str(WORD),
    conclusion: T.nullable(T.str(WORD)),
    url: T.str(GITHUB_URL),
    jobs: T.arr(T.obj({ name: text(300), conclusion: T.nullable(T.str(WORD)) }), 200),
  }),
)

export const GITHUB = T.obj({
  ...stamp,
  mainSha: T.nullable(T.str(SHA40)),
  ci: run,
  image: run,
  healthCron: T.nullable(T.obj({ conclusion: T.nullable(T.str(WORD)), url: T.str(GITHUB_URL), at: T.str(ISO) })),
  prs: T.arr(
    T.obj({
      number: T.int(),
      state: T.str(WORD),
      merged: T.bool(),
      headRef: T.nullable(T.str(BRANCH)),
      url: T.str(GITHUB_URL),
      updatedAt: T.str(ISO),
    }),
    100,
  ),
  fetchedAt: T.optional(
    T.obj({
      mainSha: T.optional(T.str(ISO)),
      ci: T.optional(T.str(ISO)),
      image: T.optional(T.str(ISO)),
      healthCron: T.optional(T.str(ISO)),
      prs: T.optional(T.str(ISO)),
    }),
  ),
  apiCalls: T.optional(T.int()),
  fetchError: T.optional(T.nullable(text(300))),
  fetchErrorAt: T.optional(T.str(ISO)),
})

const site = T.nullable(
  T.obj({
    ok: T.bool(),
    commit: T.nullable(T.str(COMMIT)),
    checkedAt: T.nullable(T.str(ISO)),
    last6: T.arr(T.bool(), 6),
    reason: T.nullable(text(1000)),
  }),
)

export const HEALTH = T.obj({
  ...stamp,
  test: site,
  prod: site,
  accessGuard: T.arr(
    T.obj({
      host: T.str(HOST),
      guarded: T.bool(),
      status: T.nullable(T.int()),
      location: T.nullable(T.str(ORIGIN_PATH)),
      gatusOk: T.nullable(T.bool()),
      error: T.optional(text(300)),
    }),
    20,
  ),
})

const deploy = T.obj({ at: T.str(ISO), event: T.str(EVENT), tag: T.nullable(T.str(TAG)), digest: T.nullable(T.str(DIGEST)) })
const backup = T.obj({
  latest: T.nullable(T.obj({ name: T.str(FILE_NAME), bytes: T.int(), mtime: T.str(ISO) })),
  offsiteDir: T.oneOf(['missing', 'ok', 'empty']),
  lastRecord: T.nullable(T.obj({ at: T.nullable(T.str(ISO)), ok: T.bool() })),
})

/** ops/status-envcheck.sh 的輸出：只有鍵名與 false/absent/other（§3.8 G5）。多出來的欄位一律不輸出。 */
export const ENVCHECK = T.obj({
  site: T.oneOf(['prod']),
  checkedAt: T.str(ISO),
  missing: T.arr(T.str(KEY_NAME), 200),
  forbiddenPresent: T.arr(T.str(KEY_NAME), 200),
  flags: T.obj({
    REGISTRATION_OPEN: T.oneOf(['false', 'absent', 'other']),
    BUSINESS_CLOCK_OVERRIDE_ENABLED: T.oneOf(['false', 'other']),
  }),
})

export const VM = T.obj({
  ...stamp,
  deploys: T.obj({ test: T.arr(deploy, 5), prod: T.arr(deploy, 5) }),
  backups: T.obj({ test: backup, prod: backup }),
  prodEnv: T.nullable(ENVCHECK),
  prodEnvError: T.nullable(text(300)),
  prodDns: T.obj({ host: T.str(HOST), hasA: T.bool(), checkedAt: T.str(ISO) }),
})

/** acceptance-index.json 的一夜（acceptance.mjs 先各自投影，不合的那夜標 invalidReason，不拖垮整個索引）。 */
export const RUN_ENTRY = T.obj({
  runId: T.str(ID),
  plan: T.nullable(T.str(WORD)),
  startedAt: T.nullable(T.str(ISO)),
  finishedAt: T.nullable(T.str(ISO)),
  commitStart: T.nullable(T.str(COMMIT)),
  commitEnd: T.nullable(T.str(COMMIT)),
  items: T.arr(T.obj({ id: T.str(ID), status: T.nullable(T.str(WORD)) }), 500),
  hasSummary: T.bool(),
  summaryValid: T.bool(),
  invalidReason: T.nullable(text(300)),
})

export const ACCEPTANCE_INDEX = T.obj({
  ...stamp,
  runs: T.arr(RUN_ENTRY, 100),
  latestFullAttempt: T.nullable(T.str(ID)),
  requiredItems: T.nullable(T.arr(T.str(ID), 200)),
  requiredItemsSourceSha: T.nullable(T.str(SHA40)),
})

export const COLLECTOR = T.obj({
  ...stamp,
  sources: T.record(/^[a-z]{1,32}$/, T.obj({ ok: T.bool(), at: T.str(ISO), error: T.nullable(text(500)) })),
})

/** repo/ 四檔：原樣複本，只檢查兩個戳記；內容由第二道黑名單把關。 */
export const REPO_FILE = T.passthrough({ sourceSha: T.str(SHA40), generatedAt: T.str(ISO) })

const BY_FILE = {
  'github.json': GITHUB,
  'health.json': HEALTH,
  'vm.json': VM,
  'acceptance-index.json': ACCEPTANCE_INDEX,
  'collector.json': COLLECTOR,
}

/** 檔名（相對 STATUS_DATA_DIR）→ 形狀。沒定義形狀的檔不准寫（寫了就是程式錯）。 */
export function shapeFor(rel) {
  if (rel.startsWith('repo/')) return REPO_FILE
  const shape = BY_FILE[rel]
  if (!shape) throw new Error(`${rel} 沒有定義輸出白名單，不寫`)
  return shape
}
