// 五條「能不能上線」判定（設計方案 §3.8、AC-S-19 (a)–(j)）。情境資料在 fixtures/gate/scenarios.ts。
import { describe, expect, it } from 'vitest'

import { LATEST, NOW, SCENARIOS, green, toGateInput, type Scenario } from '../../../fixtures/gate/scenarios'
import { classifyOutcome, formatRanges, isTaskDone, problemSteps, stepNumber } from './acceptance'
import { evaluateGoLive } from './gates'
import type { GateId, GateResult } from './types'

const now = new Date(NOW)
const run = (s: Scenario) => evaluateGoLive(toGateInput(s), now)
const gate = (s: Scenario, id: GateId): GateResult => run(s).gates.find((g) => g.id === id)!
const text = (g: GateResult) => [g.summary, ...g.reasons].join('\n')

describe('AC-S-19 五條判定', () => {
  it('(a) 五條全符合 → 五綠、可以上線', () => {
    const v = run(SCENARIOS.a())
    expect(v.gates.map((g) => [g.id, g.state])).toEqual([
      ['G1', 'green'], ['G2', 'green'], ['G3', 'green'], ['G4', 'green'], ['G5', 'green'],
    ])
    expect(v.canGoLive).toBe(true)
  })

  it('(b) CI 失敗在 e2e-smoke → G1 紅、寫出 job 名', () => {
    const g = gate(SCENARIOS.b(), 'G1')
    expect(g.state).toBe('red')
    expect(g.summary).toContain('e2e-smoke')
    expect(text(g)).not.toContain('typecheck')
    expect(run(SCENARIOS.b()).canGoLive).toBe(false)
  })

  it('(c) 2 筆要修只有 1 筆豁免 → G2 紅、只列沒被同意那筆', () => {
    const g = gate(SCENARIOS.c(), 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('S3-02')
    expect(text(g)).not.toContain('S3-01')
  })

  it('(d) 豁免寫前一夜的 runId → G2 紅（舊豁免不算）', () => {
    const g = gate(SCENARIOS.d(), 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('要修、沒被同意：story-3 S3-01')
  })

  it('(e) 正式站最新備份 25 小時前 → G4 紅', () => {
    const g = gate(SCENARIOS.e(), 'G4')
    expect(g.state).toBe('red')
    expect(g.summary).toBe('最新備份 25 小時前')
  })

  it('(f) envcheck 30 小時前 → G5 灰「設定檢查超過 26 小時沒跑」', () => {
    const g = gate(SCENARIOS.f(), 'G5')
    expect(g.state).toBe('grey')
    expect(g.summary).toBe('設定檢查超過 26 小時沒跑')
  })

  it('(g) 最新 full 只跑 1／18 項 → G2 紅，不拿前一夜充數', () => {
    const g = gate(SCENARIOS.g(), 'G2')
    expect(g.state).toBe('red')
    expect(g.summary).toBe('最新一夜只跑了 1／18 項')
    expect(text(g)).toContain('沒跑：story-2')
  })

  it('(h) 全 ok、全 parsed 但有一步「做不到（環境）」→ G2 紅（status:ok 擋不住）', () => {
    const g = gate(SCENARIOS.h(), 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('環境未完成：story-3 第 4 步')
  })

  it('(h2) 人設任務 done 空值 → G2 紅「人設任務沒完成」', () => {
    const g = gate(SCENARIOS.h2(), 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('人設任務沒完成：ux-grader 任務 3')
  })

  it('(h3) 政策檔不存在 → G2 灰「上線政策檔缺失」，不得綠', () => {
    const g = gate(SCENARIOS.h3(), 'G2')
    expect(g.state).toBe('grey')
    expect(g.summary).toBe('上線政策檔缺失')
  })

  it('(h4) parsed:true 但 story-1 沒步驟、ux-grader 只有 1／4 個任務 → G2 紅', () => {
    const g = gate(SCENARIOS.h4(), 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('story-1 缺步驟 0–7')
    expect(text(g)).toContain('ux-grader 只有 1／4 個任務')
  })

  it('(h5) 網站失敗有對應「要修」且同夜已豁免 → G2 綠', () => {
    const g = gate(SCENARIOS.h5(), 'G2')
    expect(g.state).toBe('green')
    expect(text(g)).toContain('已同意晚點修：story-2 S2-07')
    expect(run(SCENARIOS.h5()).canGoLive).toBe(true)
  })

  it('(h6) 同 (h5) 但沒有豁免 → G2 紅、列出那筆要修', () => {
    const g = gate(SCENARIOS.h6(), 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('要修、沒被同意：story-2 S2-07')
    expect(text(g)).not.toContain('沒有登錄問題')
  })

  it('(h7) 第 7 步不通過但沒有登錄問題 → G2 紅', () => {
    const g = gate(SCENARIOS.h7(), 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('story-2 第 7 步失敗但沒有登錄問題')
  })

  it('(i) 最新 full 沒有 summary.json → G2 紅「最新一夜沒有彙整結果」', () => {
    const g = gate(SCENARIOS.i(), 'G2')
    expect(g.state).toBe('red')
    expect(g.summary).toBe('最新一夜沒有彙整結果')
  })

  it('(j) story-2 parsed:false → G2 紅、列出解析失敗', () => {
    const g = gate(SCENARIOS.j(), 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('story-2 解析失敗：問題表欄數不對')
  })
})

describe('G2 其他邊界', () => {
  it('擋上線一筆就紅，豁免檔也救不了', () => {
    const s = green()
    s.runs[LATEST]!.summary!.items.find((i) => i.id === 'story-4')!.problems = [
      { 編號: 'S4-01', 嚴重度: '擋上線', 一句話: '首頁 500', 角色: '訪客', 頁面: '/', 步驟: '3', 截圖: '', 已知: '', 可開票: '是' },
    ]
    s.waivers!.waivers = [{ runId: LATEST, item: 'story-4', problemId: 'S4-01', approvedBy: 'Roy', approvedAt: '', reason: '' }]
    const g = gate(s, 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('擋上線：story-4 S4-01')
  })

  it('「建議」「待 Roy 決定」不擋', () => {
    const s = green()
    s.runs[LATEST]!.summary!.items.find((i) => i.id === 'story-4')!.problems = [
      { 編號: 'S4-02', 嚴重度: '建議', 一句話: '字太小', 角色: '訪客', 頁面: '/', 步驟: '', 截圖: '', 已知: '', 可開票: '' },
      { 編號: 'S4-03', 嚴重度: '待 Roy 決定', 一句話: '要不要加', 角色: '訪客', 頁面: '/', 步驟: '', 截圖: '', 已知: '', 可開票: '' },
    ]
    expect(gate(s, 'G2').state).toBe('green')
  })

  it('「略過（…）」算環境未完成', () => {
    const s = green()
    s.runs[LATEST]!.summary!.items.find((i) => i.id === 'story-5')!.steps[2]!.結果 = '略過（前一步沒做成）'
    expect(text(gate(s, 'G2'))).toContain('環境未完成：story-5 第 2 步')
  })

  it('只有 counts 環境 > 0、步驟表沒標也算紅', () => {
    const s = green()
    s.runs[LATEST]!.summary!.items.find((i) => i.id === 'story-6')!.counts = { 通過: 8, 環境: 2 }
    expect(text(gate(s, 'G2'))).toContain('環境未完成：story-6 回報 2 個環境問題')
  })

  it('run.json 的 item 沒跑完（failed）→ 紅；續跑成功（resumed）算跑完', () => {
    const s = green()
    s.runs[LATEST]!.run!.items.find((i) => i.id === 'story-3')!.status = 'failed'
    s.runs[LATEST]!.run!.items.find((i) => i.id === 'story-4')!.status = 'resumed'
    const g = gate(s, 'G2')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('story-3 沒有跑完（failed）')
    expect(text(g)).not.toContain('story-4')
  })

  it('人設 parsed:true 但零任務（personas[] 裡沒有它）→ 0／N 紅', () => {
    const s = green()
    const sum = s.runs[LATEST]!.summary!
    sum.personas = sum.personas.filter((p) => p.id !== 'ux-leader')
    expect(text(gate(s, 'G2'))).toContain('ux-leader 只有 0／2 個任務')
  })

  it('人設任務填「否」「部分」或照抄模板都算沒完成', () => {
    const s = green()
    const tasks = s.runs[LATEST]!.summary!.personas.find((p) => p.id === 'ux-grader')!.tasks
    tasks[0]!.done = '否'
    tasks[1]!.done = '是／否／部分'
    tasks[3]!.done = '部分'
    const t = text(gate(s, 'G2'))
    expect(t).toContain('ux-grader 任務 1')
    expect(t).toContain('ux-grader 任務 2')
    expect(t).toContain('ux-grader 任務 4')
    expect(t).not.toContain('ux-grader 任務 3')
  })

  it('dependencyNotMet → 紅', () => {
    const s = green()
    s.runs[LATEST]!.summary!.items.find((i) => i.id === 'story-3')!.dependencyNotMet = true
    expect(text(gate(s, 'G2'))).toContain('story-3 前置項目沒過')
  })

  it('從來沒有 full → 灰；政策檔 items 缺一項 → 灰', () => {
    const s = green()
    s.index!.latestFullAttempt = null
    expect(gate(s, 'G2').state).toBe('grey')
    const t = green()
    delete t.policy!.items['story-6']
    const g = gate(t, 'G2')
    expect(g.state).toBe('grey')
    expect(text(g)).toContain('story-6')
  })

  it('政策檔 story 的 steps 不是整數陣列 → 灰，不得跳過步驟檢查判綠', () => {
    const s = green()
    s.runs[LATEST]!.summary!.items.find((i) => i.id === 'story-1')!.steps = []
    ;(s.policy!.items['story-1'] as unknown as { steps: unknown }).steps = '0-7'
    const g = gate(s, 'G2')
    expect(g.state).toBe('grey')
    expect(g.summary).toBe('上線政策檔缺失')
    expect(text(g)).toContain('story-1')
    const empty = green()
    empty.policy!.items['story-2'] = {}
    expect(gate(empty, 'G2').state).toBe('grey')
    const floats = green()
    floats.policy!.items['story-3'] = { steps: [1, 2.5] }
    expect(gate(floats, 'G2').state).toBe('grey')
  })

  it('政策檔 ux 的 tasks 是字串 "4" 或不是正整數 → 灰，不得跳過人設檢查判綠', () => {
    const s = green()
    const sum = s.runs[LATEST]!.summary!
    sum.personas = sum.personas.filter((p) => p.id !== 'ux-grader')
    ;(s.policy!.items['ux-grader'] as unknown as { tasks: unknown }).tasks = '4'
    const g = gate(s, 'G2')
    expect(g.state).toBe('grey')
    expect(g.summary).toBe('上線政策檔缺失')
    expect(text(g)).toContain('ux-grader')
    for (const tasks of [0, -1, 1.5]) {
      const t = green()
      t.policy!.items['ux-leader'] = { tasks }
      expect(gate(t, 'G2').state).toBe('grey')
    }
    const none = green()
    none.policy!.items['ux-member'] = {}
    expect(gate(none, 'G2').state).toBe('grey')
  })

  it('政策檔 requiredItems 是空陣列 → 灰（不得用空集合判綠）', () => {
    const s = green()
    s.policy!.requiredItems = []
    expect(gate(s, 'G2').summary).toBe('上線政策檔缺失')
  })

  it('彙整結果壞掉 → 紅並帶出 index 的原因', () => {
    const v = evaluateGoLive(
      { ...toGateInput(green()), acceptance: { ...toGateInput(green()).acceptance, summary: { status: 'invalid', error: 'JSON 格式錯誤' } } },
      now,
    )
    const g = v.gates.find((x) => x.id === 'G2')!
    expect(g.state).toBe('red')
    expect(g.summary).toContain('彙整結果壞掉')
  })

  it('每類原因最多列 10 筆', () => {
    const s = green()
    s.runs[LATEST]!.summary!.items.find((i) => i.id === 'story-1')!.problems = Array.from({ length: 13 }, (_, k) => ({
      編號: `S1-${k}`, 嚴重度: '要修', 一句話: 'x', 角色: '系辦', 頁面: '/', 步驟: '', 截圖: '', 已知: '', 可開票: '',
    }))
    const g = gate(s, 'G2')
    expect(g.reasons.filter((r) => r.startsWith('要修、沒被同意'))).toHaveLength(10)
    expect(g.reasons).toContain('…另外還有 3 筆')
  })
})

describe('G1、G3、G4、G5 的灰與紅', () => {
  it('G1：CI 還在跑、SHA 對不上、資料過期、抓取失敗都灰', () => {
    const running = green()
    running.github!.ci!.status = 'in_progress'
    running.github!.ci!.conclusion = null
    expect(gate(running, 'G1').summary).toContain('還在跑')
    const behind = green()
    behind.github!.mainSha = 'abcdef0000000000000000000000000000000000'
    expect(gate(behind, 'G1').state).toBe('grey')
    const stale = green()
    stale.github!.generatedAt = '2026-10-12T08:00:00+08:00'
    expect(gate(stale, 'G1').summary).toContain('超過 30 分鐘')
    const failed = green()
    failed.github!.fetchError = 'HTTP 503'
    expect(gate(failed, 'G1').state).toBe('grey')
  })

  it('G3：collector 判 ok:false（例如 worker 心跳逾時）即使六筆都 true 也紅，並列出原因', () => {
    const s = green()
    s.health!.test!.ok = false
    s.health!.test!.reason = 'worker 心跳 600 秒前'
    const g = gate(s, 'G3')
    expect(g.state).toBe('red')
    expect(text(g)).toContain('worker 心跳 600 秒前')
    expect(run(s).canGoLive).toBe(false)
  })

  it('G3：最近一次失敗紅；不到 6 次或過期灰；剛恢復灰', () => {
    const down = green()
    down.health!.test!.last6 = [false, true, true, true, true, true]
    expect(gate(down, 'G3').state).toBe('red')
    const few = green()
    few.health!.test!.last6 = [true, true]
    expect(gate(few, 'G3').state).toBe('grey')
    const stale = green()
    stale.health!.test!.checkedAt = '2026-10-12T08:40:00+08:00'
    expect(gate(stale, 'G3').state).toBe('grey')
    const recovered = green()
    recovered.health!.test!.last6 = [true, true, false, true, true, true]
    expect(gate(recovered, 'G3').summary).toContain('剛恢復')
  })

  it('G4：沒有任何備份紅（不是灰）；0 bytes 紅；vm.json 過期灰', () => {
    const none = green()
    none.vm!.backups.prod.latest = null
    expect(gate(none, 'G4')).toMatchObject({ state: 'red', summary: '正式站還沒有任何備份' })
    const empty = green()
    empty.vm!.backups.prod.latest!.bytes = 0
    expect(gate(empty, 'G4').state).toBe('red')
    const stale = green()
    stale.vm!.generatedAt = '2026-10-12T07:00:00+08:00'
    expect(gate(stale, 'G4').state).toBe('grey')
    expect(gate(stale, 'G5').state).toBe('grey')
  })

  it('G5：缺鍵、不該有的鍵、旗標不是 false 都紅，只列鍵名', () => {
    const s = green()
    s.vm!.prodEnv = {
      ...s.vm!.prodEnv!,
      missing: ['DATABASE_URL'],
      forbiddenPresent: ['E2E_ADMIN_PASSWORD'],
      flags: { REGISTRATION_OPEN: 'other', BUSINESS_CLOCK_OVERRIDE_ENABLED: 'other' },
    }
    const g = gate(s, 'G5')
    expect(g.state).toBe('red')
    expect(g.reasons).toEqual([
      '缺少：DATABASE_URL',
      '不該有：E2E_ADMIN_PASSWORD',
      'REGISTRATION_OPEN 不是 false',
      'BUSINESS_CLOCK_OVERRIDE_ENABLED 不是 false',
    ])
  })

  it('G5（AC-DV-09）：缺 prodDns 或 DNS 檢查超過 26 小時 → 灰「DNS 檢查沒有資料」', () => {
    const missing = green()
    delete missing.vm!.prodDns
    expect(gate(missing, 'G5')).toMatchObject({ state: 'grey', summary: 'DNS 檢查沒有資料' })
    const stale = green()
    stale.vm!.prodDns!.checkedAt = new Date(now.getTime() - 27 * 3_600_000).toISOString()
    expect(gate(stale, 'G5')).toMatchObject({ state: 'grey', summary: 'DNS 檢查沒有資料' })
    expect(run(missing).canGoLive).toBe(false)
  })

  it('G5（AC-DV-09）：hasA:false → 紅、原因帶欄位裡的 host；envcheck 也壞時兩種原因都列', () => {
    const noA = green()
    noA.vm!.prodDns!.hasA = false
    const g = gate(noA, 'G5')
    expect(g.state).toBe('red')
    expect(g.reasons).toContain('fju.roy422.dev 沒有 A 記錄')
    const other = green()
    other.vm!.prodDns = { ...other.vm!.prodDns!, host: 'example.test', hasA: false }
    expect(gate(other, 'G5').reasons).toContain('example.test 沒有 A 記錄')
    noA.vm!.prodEnv = { ...noA.vm!.prodEnv!, missing: ['DATABASE_URL'] }
    const both = gate(noA, 'G5')
    expect(both.state).toBe('red')
    expect(both.reasons).toEqual(['缺少：DATABASE_URL', 'fju.roy422.dev 沒有 A 記錄'])
  })
})

describe('小工具', () => {
  it('stepNumber／problemSteps', () => {
    expect(stepNumber('0 記下測試站版本')).toBe(0)
    expect(stepNumber('12 首頁')).toBe(12)
    expect(stepNumber('沒有號碼')).toBeNull()
    expect(problemSteps('5、7')).toEqual([5, 7])
    expect(problemSteps('第 7 步')).toEqual([7])
    expect(problemSteps('—')).toEqual([])
  })

  it('formatRanges', () => {
    expect(formatRanges([1, 2, 3, 5, 7, 8])).toBe('1–3、5、7–8')
    expect(formatRanges([4])).toBe('4')
  })

  it('classifyOutcome：五種寫法分三類，其他認不得', () => {
    expect(classifyOutcome('通過')).toBe('pass')
    expect(classifyOutcome(' 做不到（環境：網路斷） ')).toBe('env')
    expect(classifyOutcome('略過（前一步失敗）')).toBe('env')
    expect(classifyOutcome('不通過')).toBe('site')
    expect(classifyOutcome('做不到（網站：按鈕沒反應）')).toBe('site')
    expect(classifyOutcome('OK')).toBe('unknown')
  })

  it('isTaskDone', () => {
    expect(isTaskDone('是')).toBe(true)
    expect(isTaskDone('是（但很慢）')).toBe(true)
    expect(isTaskDone('是／否／部分')).toBe(false)
    expect(isTaskDone('否')).toBe(false)
    expect(isTaskDone(null)).toBe(false)
  })
})
