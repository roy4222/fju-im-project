// 合法例 5：跨模組的 re-export 只帶型別就沒問題。
export type { DemoId } from '../../domain/demo'
export type { OtherId } from '../../domain/other'
