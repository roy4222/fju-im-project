/**
 * G2：驗收——擋上線 0、要修 0 或每項經 Roy 同意（設計方案 §3.8、AC-S-19）。
 *
 * 只看 `latestFullAttempt`（最新一次 full 嘗試），不回退到更早成功的那夜。
 * 判定順序：政策檔不能用 → 灰；從來沒有 full → 灰；其餘任何一條不成立 → 紅，並把所有原因列出來。
 */
import type { PolicyItemRequirement, SummaryItem, SummaryJson, SummaryPersona, Waiver } from '@/lib/data/types'

import type { AcceptanceGateInput, GateResult } from './types'

const TITLE = '驗收：擋上線 0、要修 0 或每項經 Roy 同意'
/** 每類原因最多列幾筆（§3.8「各列前 10 筆」）。 */
export const MAX_PER_KIND = 10

/** run.json 裡算「跑完了」的狀態：`resumed` 是續跑後成功結束（`acceptance-night.sh:584`，該檔 `:705` 與 ok 同等看待）。 */
const RUN_OK = new Set(['ok', 'resumed'])

/** 步驟列 `步驟` 欄開頭的整數，例如 `"1 記下測試站版本"` → 1。 */
export function stepNumber(step: string): number | null {
  const m = /^\s*(\d+)/.exec(step)
  return m ? Number(m[1]) : null
}

/** 問題列 `步驟` 欄裡的所有步驟號（可能是「7」、「第 7 步」、「5、7」；空白或「—」沒有）。 */
export function problemSteps(step: string | null | undefined): number[] {
  return [...(step ?? '').matchAll(/\d+/g)].map((m) => Number(m[0]))
}

/** 把步驟號壓成範圍文字：[1,2,3,5] → 「1–3、5」。 */
export function formatRanges(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`)
    i = j + 1
  }
  return parts.join('、')
}

/** 劇本規定的五種 `結果` 寫法分三類（`story-2-semester.md:182`）；其他寫法算「認不得」。 */
export type StepOutcome = 'pass' | 'env' | 'site' | 'unknown'
export function classifyOutcome(result: string): StepOutcome {
  const r = result.trim()
  if (r === '通過') return 'pass'
  if (r.startsWith('做不到（環境') || r.startsWith('略過（') || r === '略過') return 'env'
  if (r === '不通過' || r.startsWith('不通過（') || r.startsWith('做不到（網站')) return 'site'
  return 'unknown'
}

/**
 * 人設任務的「完成」欄（`summarize-night.sh:235` 抓第一個非空白片段）：
 * 模板是「是／否／部分」，只有以「是」開頭、且不是原封不動的模板字串才算完成；空值算沒完成。
 */
export function isTaskDone(done: string | null | undefined): boolean {
  const d = (done ?? '').trim()
  return d.startsWith('是') && !d.includes('／')
}

const BLOCKING = '擋上線'
const MUST_FIX = '要修'

function cap(list: string[]): string[] {
  return list.length > MAX_PER_KIND ? [...list.slice(0, MAX_PER_KIND), `…另外還有 ${list.length - MAX_PER_KIND} 筆`] : list
}

function grey(summary: string, reasons: string[] = []): GateResult {
  return { id: 'G2', title: TITLE, state: 'grey', summary, reasons }
}

type PolicyCheck =
  | { ok: true; required: string[]; items: Record<string, PolicyItemRequirement> }
  | { ok: false; reason: string }

function checkPolicy(input: AcceptanceGateInput): PolicyCheck {
  const p = input.policy
  if (p.status === 'missing') return { ok: false, reason: '找不到 repo/go-live-policy.json' }
  if (p.status === 'invalid') return { ok: false, reason: `repo/go-live-policy.json 壞掉：${p.error}` }
  const { requiredItems, items } = p.data
  if (!Array.isArray(requiredItems) || requiredItems.length === 0 || !requiredItems.every((x) => typeof x === 'string')) {
    return { ok: false, reason: 'requiredItems 不是非空的字串陣列' }
  }
  if (!items || typeof items !== 'object' || Array.isArray(items)) return { ok: false, reason: '缺少 items（每項的證據要求）' }
  const missing = requiredItems.filter((id) => !items[id] || typeof items[id] !== 'object')
  if (missing.length) return { ok: false, reason: `items 缺少：${missing.join('、')}` }
  return { ok: true, required: requiredItems, items }
}

export function evaluateAcceptance(input: AcceptanceGateInput): GateResult {
  // (g) 政策檔缺了或壞了 → 灰，不得用空集合判綠。
  const policy = checkPolicy(input)
  if (!policy.ok) return grey('上線政策檔缺失', [policy.reason])
  const { required, items: requirements } = policy

  const runId = input.index?.latestFullAttempt ?? null
  if (!input.index) return grey('還沒有驗收索引（acceptance-index.json）')
  if (!runId) return grey('從來沒有跑過完整的一夜驗收（plan=full）')

  const red = (summary: string, reasons: string[]): GateResult => ({
    id: 'G2',
    title: TITLE,
    state: 'red',
    summary,
    reasons,
  })

  // (a) run.json 的 item 齊全且都跑完。
  const entry = input.index.runs.find((r) => r.runId === runId) ?? null
  const runItems = input.run?.items ?? entry?.items ?? null
  if (!runItems) return red(`讀不到最新一夜（${runId}）的 run.json`, [])
  const statusById = new Map(runItems.map((i) => [i.id, i.status]))
  const present = required.filter((id) => statusById.has(id))
  const reasons: string[] = []
  const notRun = required.filter((id) => !statusById.has(id))
  if (notRun.length) {
    reasons.push(`最新一夜只跑了 ${present.length}／${required.length} 項`)
    reasons.push(...cap(notRun.map((id) => `沒跑：${id}`)))
  }
  reasons.push(
    ...cap(present.filter((id) => !RUN_OK.has(statusById.get(id)!)).map((id) => `${id} 沒有跑完（${statusById.get(id)}）`)),
  )

  // (b) summary.json 存在且合法。
  const s = input.summary
  if (s.status !== 'ok') {
    const why =
      s.status === 'missing'
        ? '最新一夜沒有彙整結果'
        : `最新一夜的彙整結果壞掉：${s.error}${entry?.invalidReason ? `（${entry.invalidReason}）` : ''}`
    return red(why, [why, ...reasons])
  }
  if (entry && entry.summaryValid === false) {
    const why = `最新一夜的彙整結果壞掉${entry.invalidReason ? `：${entry.invalidReason}` : ''}`
    return red(why, [why, ...reasons])
  }
  const summary = s.data
  const items = Array.isArray(summary.items) ? summary.items : []
  const personas = Array.isArray(summary.personas) ? summary.personas : []
  const waivers = input.waivers?.waivers ?? []

  const parse: string[] = []
  const coverage: string[] = []
  const env: string[] = []
  const unlogged: string[] = []
  const unknown: string[] = []
  const blocking: string[] = []
  const unwaived: string[] = []
  const tasksUndone: string[] = []

  for (const id of present) {
    const item = items.find((i) => i.id === id)
    if (!item) {
      parse.push(`${id} 不在彙整結果裡`)
      continue
    }
    if (item.parsed !== true) {
      const errs = Array.isArray(item.errors) && item.errors.length ? `：${item.errors.slice(0, 3).join('；')}` : ''
      parse.push(`${id} 解析失敗${errs}`)
    } else if (Array.isArray(item.errors) && item.errors.length) {
      parse.push(`${id} 解析有錯：${item.errors.slice(0, 3).join('；')}`)
    }
    if (item.dependencyNotMet) parse.push(`${id} 前置項目沒過（dependency-not-met）`)

    const req = requirements[id]!
    checkSteps(id, item, req, coverage, env, unlogged, unknown)
    checkProblems(id, item, runId, waivers, blocking, unwaived)
    if (typeof req.tasks === 'number') checkPersona(id, personas, req.tasks, coverage, tasksUndone)
  }

  reasons.push(
    ...cap(parse),
    ...cap(coverage),
    ...cap(env),
    ...cap(unlogged),
    ...cap(unknown),
    ...cap(tasksUndone),
    ...cap(blocking),
    ...cap(unwaived),
  )

  if (reasons.length) {
    return { ...red(reasons[0]!, reasons), link: summaryLink(runId) }
  }
  return {
    id: 'G2',
    title: TITLE,
    state: 'green',
    summary: `最新一夜（${runId}）${required.length} 項齊全、全部通過`,
    reasons: waivedNotes(summary, runId, waivers, present),
    link: summaryLink(runId),
  }
}

function summaryLink(runId: string) {
  return { href: `/map`, label: `看 ${runId} 的測試地圖` }
}

/** (a′) 必要步驟齊全；(e) 每一步的結果。 */
function checkSteps(
  id: string,
  item: SummaryItem,
  req: PolicyItemRequirement,
  coverage: string[],
  env: string[],
  unlogged: string[],
  unknown: string[],
) {
  const steps = Array.isArray(item.steps) ? item.steps : []
  if (Array.isArray(req.steps) && req.steps.length) {
    const seen = new Set(steps.map((st) => stepNumber(st.步驟)).filter((n): n is number => n !== null))
    const lacking = req.steps.filter((n) => !seen.has(n))
    if (lacking.length) coverage.push(`${id} 缺步驟 ${formatRanges(lacking)}`)
  }
  const problems = Array.isArray(item.problems) ? item.problems : []
  let envSteps = 0
  for (const st of steps) {
    const n = stepNumber(st.步驟)
    const label = n === null ? `「${st.步驟}」` : `第 ${n} 步`
    switch (classifyOutcome(st.結果 ?? '')) {
      case 'pass':
        break
      case 'env':
        envSteps++
        env.push(`環境未完成：${id} ${label}（${st.結果.trim()}）`)
        break
      case 'site': {
        const logged = n !== null && problems.some((p) => problemSteps(p.步驟).includes(n))
        if (!logged) unlogged.push(`${id} ${label}失敗但沒有登錄問題（${st.結果.trim()}）`)
        break
      }
      case 'unknown':
        unknown.push(`${id} ${label}的結果寫法認不得：「${st.結果}」`)
    }
  }
  const envCount = item.counts?.['環境'] ?? 0
  if (envCount > 0 && envSteps === 0) env.push(`環境未完成：${id} 回報 ${envCount} 個環境問題`)
}

/** (c) 擋上線 0；(d) 要修每筆都在同一夜的豁免檔。 */
function checkProblems(id: string, item: SummaryItem, runId: string, waivers: Waiver[], blocking: string[], unwaived: string[]) {
  for (const p of Array.isArray(item.problems) ? item.problems : []) {
    const level = (p.嚴重度 ?? '').trim()
    const text = `${id} ${p.編號}：${p.一句話}`
    if (level === BLOCKING) blocking.push(`擋上線：${text}`)
    else if (level === MUST_FIX && !isWaived(waivers, runId, id, p.編號)) unwaived.push(`要修、沒被同意：${text}`)
  }
}

function isWaived(waivers: Waiver[], runId: string, item: string, problemId: string) {
  return waivers.some((w) => w.runId === runId && w.item === item && w.problemId === problemId)
}

/** (a′) 人設任務數；(f) 每個任務都完成。parsed:true 但零任務的人設不會出現在 personas[]（`summarize-night.sh:694`）。 */
function checkPersona(id: string, personas: SummaryPersona[], need: number, coverage: string[], undone: string[]) {
  const persona = personas.find((p) => p.id === id)
  const tasks = Array.isArray(persona?.tasks) ? persona.tasks : []
  if (tasks.length < need) coverage.push(`${id} 只有 ${tasks.length}／${need} 個任務`)
  for (const t of tasks) {
    if (!isTaskDone(t.done)) undone.push(`人設任務沒完成：${id} 任務 ${t.task}（${t.done ? `填「${t.done}」` : '沒填'}）`)
  }
}

/** 綠的時候提示哪些「要修」是靠豁免過的。 */
function waivedNotes(summary: SummaryJson, runId: string, waivers: Waiver[], present: string[]): string[] {
  const notes: string[] = []
  for (const item of summary.items ?? []) {
    if (!present.includes(item.id)) continue
    for (const p of item.problems ?? []) {
      if ((p.嚴重度 ?? '').trim() === MUST_FIX && isWaived(waivers, runId, item.id, p.編號)) {
        notes.push(`已同意晚點修：${item.id} ${p.編號}：${p.一句話}`)
      }
    }
  }
  return cap(notes)
}
