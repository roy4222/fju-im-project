/**
 * 學生零可見的掃描器（票 23；產品模組 06 §4「7.6」、案例 GRD-11；模組實作設計 06 §2「學生輸出不含分數評語排名」）。
 *
 * 掃的是**原始回應本文**（HTML 連同內嵌的 RSC payload、RSC 請求的 flight 資料、JSON），不是畫面上看得到的字：
 * Server Component 傳給 Client Component 的任何 prop 都會進 payload，就算畫面沒顯示，view-source 也看得到。
 *
 * 兩種命中：
 * 1. 已知數值：種子資料故意用不常見的分數（例如 77.31、63.47），一般頁面不可能剛好出現。
 * 2. 評分資料的欄位名：`"scores":`、`"teacherScore":`、`"evaluationId":` 這種 JSON key。
 */

/** 評分資料會用到的欄位名（出現在 JSON／RSC payload 的 key 位置才算）。 */
export const SCORE_FIELD_PATTERN =
  /"(scores?|teacherScore|finalScore|stageScore|evaluationId|evaluations|grade|grades|rank|ranking|comment|comments|counted)"\s*:/g

export type ScanHit = { kind: 'value' | 'field'; match: string; context: string }

function around(body: string, index: number, length: number): string {
  return body.slice(Math.max(0, index - 60), Math.min(body.length, index + length + 60)).replace(/\s+/g, ' ')
}

/** 回傳所有命中；空陣列＝這份回應沒有任何分數或評分欄位。 */
export function scanBody(body: string, knownValues: readonly string[]): ScanHit[] {
  const hits: ScanHit[] = []
  for (const value of knownValues) {
    // 數值前後不能還是數字（避免 "177.312" 這種巧合），也允許出現在 JSON 字串或 HTML 文字裡。
    const pattern = new RegExp(`(?<![0-9.])${value.replace('.', '\\.')}(?![0-9])`, 'g')
    for (const m of body.matchAll(pattern)) hits.push({ kind: 'value', match: m[0], context: around(body, m.index ?? 0, m[0].length) })
  }
  for (const m of body.matchAll(SCORE_FIELD_PATTERN)) {
    hits.push({ kind: 'field', match: m[0], context: around(body, m.index ?? 0, m[0].length) })
  }
  return hits
}
