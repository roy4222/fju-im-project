#!/usr/bin/env node
/**
 * S00-06 的斷言腳本：把 `lint-fixtures/` 的七個反例與三個合法例跑過 lint，
 * 逐檔核對「該被擋的被擋、該放行的放行」，而且被擋的理由必須是預期的那條規則。
 *
 * 規則被改壞（放寬邊界、拿掉 server-only 檢查）時，這支會先紅。
 */
import { ESLint } from 'eslint'
import path from 'node:path'

const webRoot = path.join(import.meta.dirname, '..')

/** 七個反例：檔案 → 預期攔下它的規則。 */
const MUST_FAIL = [
  ['lint-fixtures/src/domain/demo/invalid-domain-imports-framework.ts', 'fju/external-packages'],
  ['lint-fixtures/src/domain/demo/invalid-domain-imports-infrastructure.ts', 'boundaries/dependencies'],
  ['lint-fixtures/src/application/demo/invalid-application-imports-infrastructure.ts', 'boundaries/dependencies'],
  ['lint-fixtures/src/app/demo/invalid-page-imports-infrastructure.tsx', 'boundaries/dependencies'],
  ['lint-fixtures/src/app/demo/invalid-client-imports-composition.tsx', 'fju/client-server-boundary'],
  ['lint-fixtures/src/app/demo/invalid-actions/actions.ts', 'fju/actions-file-contract'],
  ['lint-fixtures/src/application/demo/invalid-direct-auth-api.ts', 'no-restricted-imports'],
]

/** 三個合法例：一個錯都不該有。 */
const MUST_PASS = [
  'lint-fixtures/src/app/demo/valid-actions/form.tsx',
  'lint-fixtures/src/application/demo/valid-application-uses-domain.ts',
  'lint-fixtures/src/app/demo/valid-page-uses-composition.tsx',
]

const eslint = new ESLint({ cwd: webRoot })
const results = await eslint.lintFiles([...MUST_FAIL.map(([f]) => f), ...MUST_PASS])
const byFile = new Map(results.map((r) => [path.relative(webRoot, r.filePath), r]))

const failures = []
const lines = []

for (const [file, expectedRule] of MUST_FAIL) {
  const result = byFile.get(file)
  const errors = (result?.messages ?? []).filter((m) => m.severity === 2)
  const ruleIds = [...new Set(errors.map((m) => m.ruleId))]
  if (errors.length === 0) {
    failures.push(`${file}：應該被擋，實際沒有任何 error`)
    lines.push(`FAIL  ${file}  （沒被擋）`)
  } else if (!ruleIds.includes(expectedRule)) {
    failures.push(`${file}：應該被 ${expectedRule} 擋，實際是 ${ruleIds.join(', ')}`)
    lines.push(`FAIL  ${file}  （理由不對：${ruleIds.join(', ')}）`)
  } else {
    lines.push(`ok    ${file}  ← ${expectedRule}（${errors.length} error）`)
  }
}

for (const file of MUST_PASS) {
  const result = byFile.get(file)
  const errors = (result?.messages ?? []).filter((m) => m.severity === 2)
  if (errors.length > 0) {
    failures.push(`${file}：應該放行，實際被 ${[...new Set(errors.map((m) => m.ruleId))].join(', ')} 擋`)
    lines.push(`FAIL  ${file}  （被誤擋：${errors.map((m) => `${m.ruleId} ${m.message}`).join(' / ')}）`)
  } else {
    lines.push(`ok    ${file}  ← 放行`)
  }
}

console.log(`分層 lint fixtures：${MUST_FAIL.length} 個反例、${MUST_PASS.length} 個合法例`)
for (const line of lines) console.log('  ' + line)

if (failures.length > 0) {
  console.error('\n分層 lint 斷言失敗：')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('\n全部符合預期。')
