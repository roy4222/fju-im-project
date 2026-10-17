import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * 畫面用詞規則（AD-33b，AC-AD-33）：側欄與分頁列換成新名後，頁面上的字串還是一再冒出舊名
 * （Q83「專題事務」→「公告與作業」、「繳交項目」→「作業」）。系辦「評分」改叫「成績」，返回連結「← 評分」也算舊名。這支掃 `src/app/**` 與操作紀錄的對照表，
 * 字串常值、模板字串、JSX 文字裡出現舊名就失敗。註解不算；測試檔不掃。
 *
 * AD-33c 擴大到 `src/application/**`、`src/infrastructure/**`：通知標題、錯誤訊息、回執也是使用者看得到的字。
 * 資料表定義（`db/schema/**`）與權限表（`db/permissions/**`）不掃；migration 在 `drizzle/`，本來就不在範圍內。
 *
 * 「站內同意書」是術語表的正式用語（Signoff Package Version），不是舊名，不掃（AD-33d）。
 *
 * 暫時留著的列在 ALLOWED，每一筆寫理由與次數（次數不對也會失敗，改掉之後記得把那一筆刪掉）。
 */
const LEGACY_TERMS = ['專題事務', '繳交項目', '收件項目', '← 評分'] as const

const WEB = fileURLToPath(new URL('..', import.meta.url))

const ALLOWED: readonly { file: string; term: (typeof LEGACY_TERMS)[number]; count: number; reason: string }[] = []

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(WEB, dir), { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name) && !/\.(test|spec)\.tsx?$/.test(d.name))
    .map((d) => path.relative(WEB, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
}

/** 檔案裡會變成畫面文字的部分：字串、模板字串的每一段、JSX 文字。註解不在 AST 節點裡，自然略過。 */
function literalTexts(file: string): string[] {
  const text = readFileSync(path.join(WEB, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) out.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

/** 使用者看不到的資料庫定義：表名、欄位說明、權限名。 */
const NOT_USER_FACING = /^src\/infrastructure\/db\/(schema|permissions)\//

function countHits(): Map<string, number> {
  const hits = new Map<string, number>()
  const files = [...sourceFiles('src/app'), ...sourceFiles('src/application'), ...sourceFiles('src/infrastructure')].filter(
    (f) => !NOT_USER_FACING.test(f),
  )
  for (const file of files) {
    for (const literal of literalTexts(file)) {
      for (const term of LEGACY_TERMS) {
        const n = literal.split(term).length - 1
        if (n > 0) hits.set(`${file}｜${term}`, (hits.get(`${file}｜${term}`) ?? 0) + n)
      }
    }
  }
  return hits
}

describe('畫面舊用詞（AD-33b、AD-33c，AC-AD-33）', () => {
  it('src/app、src/application、src/infrastructure 的字串裡沒有「專題事務」「繳交項目」「收件項目」「← 評分」（白名單除外，次數要對）', () => {
    const hits = Object.fromEntries(countHits())
    const allowed = Object.fromEntries(ALLOWED.map((a) => [`${a.file}｜${a.term}`, a.count]))
    expect(hits).toEqual(allowed)
  })

  it('白名單每一筆都有理由', () => {
    for (const a of ALLOWED) expect(a.reason.trim(), a.file).not.toBe('')
  })
})
