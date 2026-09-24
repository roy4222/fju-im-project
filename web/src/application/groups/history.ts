import type { GroupHistoryEntry } from '@/application/groups/ports'

/**
 * 組別歷程一筆的顯示文字（學生「我的組別」、老師「分組」、管理員組別詳情共用）。
 * 操作者（`byName`）只在管理員的查詢裡有值，其他人看到的就沒有括號那一段。
 */
export function describeGroupHistory(entry: GroupHistoryEntry): string {
  const by = entry.byName ? `（${entry.byName}）` : ''
  switch (entry.kind) {
    case 'member_added':
      return `${entry.userName} 加入${by}`
    case 'member_removed':
      return `${entry.userName} 移出${by}`
    case 'leader_changed':
      return `組長 ${entry.previousLeaderName ?? '—'} → ${entry.userName}${by}`
    case 'advisor_assigned':
      return entry.previousAdvisorName
        ? `指導老師 ${entry.previousAdvisorName} → ${entry.userName}${by}`
        : `指導老師：${entry.userName}${by}`
    case 'advisor_removed':
      return `解除指導老師 ${entry.userName}${by}`
  }
}
