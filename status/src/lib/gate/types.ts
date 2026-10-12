/**
 * 五條「能不能上線」的共同形狀（設計方案 §3.8）。
 *
 * 每條只有三種結果：綠＝過、紅＝不過、灰＝資料不夠（算不過）。五條全綠才是「可以上線」。
 */
import type { ReadResult } from '@/lib/data/read'
import type {
  AcceptanceIndex,
  GithubData,
  GoLivePolicyFile,
  GoLiveWaiversFile,
  HealthData,
  RepoCopy,
  RunJson,
  SummaryJson,
  VmData,
} from '@/lib/data/types'

export type GateState = 'green' | 'red' | 'grey'

export type GateId = 'G1' | 'G2' | 'G3' | 'G4' | 'G5'

export type GateResult = {
  id: GateId
  /** 條件本身，例如「CI 全綠」 */
  title: string
  state: GateState
  /** 一句話結論（綠紅灰都有） */
  summary: string
  /** 紅、灰時的細項（每類最多 10 筆）；綠時可放提示 */
  reasons: string[]
  link?: { href: string; label: string }
}

/** G2 要讀的東西（latestFullAttempt 那夜的 run.json／summary.json 與兩個 repo 檔）。 */
export type AcceptanceGateInput = {
  index: AcceptanceIndex | null
  /** latestFullAttempt 那夜的 run.json；讀不到是 null（改用 index 裡的 items） */
  run: RunJson | null
  summary: ReadResult<SummaryJson>
  policy: ReadResult<RepoCopy<GoLivePolicyFile>>
  waivers: GoLiveWaiversFile | null
}

export type GateInput = {
  github: GithubData | null
  health: HealthData | null
  vm: VmData | null
  acceptance: AcceptanceGateInput
}

export type GoLiveVerdict = {
  canGoLive: boolean
  gates: GateResult[]
}
