import type { TeacherSignoffCard } from '@/application/signoff'

/**
 * 老師首頁的同意書摘要（票 31 後續，Codex P2）。
 *
 * 一組可能同時有「期中結果確認」與「最終文件授權」兩個簽核包，簽核頁是一包一張卡；
 * 但首頁寫的是「待我同意 n 組」「等待學生 n 組」（產品模組 07：每個指導組一張卡，單位是組），
 * 所以數字要依組別去重，不能直接數卡片。清單本身仍然一包一列（兩份都要去簽）。
 *
 * - 待我同意：目前那一版輪到老師（`teacher_pending`）、我是這一版快照裡的主指導、還沒表態。
 * - 等待學生：目前那一版還在收學生同意（`collecting`）。
 */
export function teacherSignoffSummary(cards: readonly TeacherSignoffCard[]) {
  const ready = cards.filter((c) => c.current.state === 'teacher_pending' && c.mine.isSnapshotAdvisor && c.mine.voted === null)
  const waiting = cards.filter((c) => c.current.state === 'collecting')
  const groupsOf = (list: readonly TeacherSignoffCard[]) => new Set(list.map((c) => c.groupId)).size
  return { ready, waiting, readyGroups: groupsOf(ready), waitingGroups: groupsOf(waiting) }
}
