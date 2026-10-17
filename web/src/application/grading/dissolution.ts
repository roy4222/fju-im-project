/**
 * 評分模組對外的「組別解散」掛點（A-19；PR #333）。獨立成檔，不動 `ports.ts`（歸 A-01／A-05，B 階段設計方案 §17.2）；
 * 由 `index.ts` 一行 `export type` 匯出（跨模組只能走公開入口）。
 */

/**
 * 組別解散時停止評分工作（開站後；產品模組 03 §4「解散：06 停止」、模組實作設計 03 §6「解散同交易 05／06／07」）。
 *
 * 由模組 03 的解散用例在**它的交易裡**呼叫（composition 注入，同 `SignoffParticipantHook` 的作法）；呼叫前組別列已經
 * `FOR UPDATE`，所以跟評分寫入（組別 `FOR SHARE` → 指派 `FOR UPDATE`）同向排隊。
 * 結束這組全部有效評分指派（`removal_choice` 留空＝因解散結束，不是改派）、暫存一律失效；已正式送出的分數照舊採計、凍結。
 * 不發事件：評分工作停止的老師由解散事件一起通知（產品 08 §4「組別解散」每人一則）。
 */
export interface GradingDissolutionHook<Tx = unknown> {
  endForDissolvedGroup(
    tx: Tx,
    input: {
      readonly groupId: string
      readonly cohortId: string
      readonly actorUserId: string
      /** 解散理由（只留在系辦的稽核）；指派的結束理由與暫存失效的事件只寫中性的「組別解散」，因為評分老師看得到。 */
      readonly reason: string
      readonly realAt: Date
      readonly businessAt: Date
    },
  ): Promise<{
    readonly endedAssignmentIds: readonly string[]
    readonly invalidatedDraftIds: readonly string[]
    /** 評分工作因此停止的老師（有效指派被結束的人，去重）。 */
    readonly teacherUserIds: readonly string[]
    /** 解散當下這屆評分方案的目前版本（還沒建方案就是 null）。 */
    readonly schemeVersion: { readonly id: string; readonly versionNo: number; readonly status: string } | null
  }>
}
