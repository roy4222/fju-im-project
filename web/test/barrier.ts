/**
 * 同步屏障（母 spec §5：「並行與故障用同步屏障，不用固定 sleep」）。
 *
 * 讓 N 個並行的交易在指定的一點會合：每一方呼叫 `arrive()` 後會等到最後一方也到達，
 * 才一起往下走。這樣「兩筆交易同時想改同一列」這種情境可以穩定重現，不必賭 sleep 的時間。
 */
export type Barrier = {
  /** 到達屏障並等其他人；全部到齊才 resolve。 */
  arrive(): Promise<void>
  /** 已經到達的人數。 */
  readonly arrived: number
  /** 提早解除（例如某一方失敗了，不要讓其他人卡到逾時）。 */
  abort(reason: string): void
}

export function createBarrier(parties: number, options?: { timeoutMs?: number }): Barrier {
  if (parties < 1) throw new RangeError('屏障至少要有一方')
  const timeoutMs = options?.timeoutMs ?? 5_000

  let arrived = 0
  let released = false
  const waiters: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }[] = []

  function releaseAll() {
    released = true
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
    waiters.length = 0
  }

  return {
    get arrived() {
      return arrived
    },
    arrive() {
      if (released) return Promise.resolve()
      arrived += 1
      if (arrived >= parties) {
        releaseAll()
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`屏障等了 ${timeoutMs}ms 還沒到齊（${arrived}/${parties}）`))
        }, timeoutMs)
        waiters.push({ resolve, reject, timer })
      })
    },
    abort(reason: string) {
      released = true
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`屏障被中止：${reason}`))
      }
      waiters.length = 0
    },
  }
}
