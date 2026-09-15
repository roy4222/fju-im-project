// 合法例 4：跨模組只帶型別，執行期要用就經 composition 注入的 port。
import type { DemoId } from '../../domain/demo'
import type { OtherId } from '../../domain/other'

export type Pairing = { demo: DemoId; other: OtherId }

export function describe(pairing: Pairing): string {
  return `${pairing.demo}/${pairing.other}`
}
