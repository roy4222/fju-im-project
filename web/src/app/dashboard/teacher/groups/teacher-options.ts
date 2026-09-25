type GroupAdvisor = {
  readonly code: string
  readonly advisor: { readonly teacherUserId: string; readonly teacherName: string } | null
}

/**
 * 分組總覽「指導老師」篩選的選項：值是老師的帳號 ID、標籤是姓名，同名的兩位老師不會被併成一個選項。
 * 同名時標籤後面加上他指導的組別（例如「王老師（G01、G05）」）好分辨——組別這一頁本來就列給所有老師看，
 * 不多讀任何欄位。
 */
export function teacherFilterOptions(groups: readonly GroupAdvisor[]): { value: string; label: string }[] {
  const byTeacher = new Map<string, { name: string; codes: string[] }>()
  for (const g of groups) {
    if (!g.advisor) continue
    const entry = byTeacher.get(g.advisor.teacherUserId) ?? { name: g.advisor.teacherName, codes: [] }
    entry.codes.push(g.code)
    byTeacher.set(g.advisor.teacherUserId, entry)
  }
  const nameCount = new Map<string, number>()
  for (const { name } of byTeacher.values()) nameCount.set(name, (nameCount.get(name) ?? 0) + 1)
  return [...byTeacher.entries()]
    .map(([value, { name, codes }]) => ({
      value,
      label: (nameCount.get(name) ?? 0) > 1 ? `${name}（${[...codes].sort((a, b) => a.localeCompare(b)).join('、')}）` : name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'))
}
