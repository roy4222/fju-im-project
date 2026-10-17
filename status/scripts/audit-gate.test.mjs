import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./audit-gate.mjs', import.meta.url))
const exemptId = 'GHSA-vfj7-8cjw-p6xm'
const exemptUrl = `https://github.com/advisories/${exemptId}`
const otherId = 'GHSA-2345-6789-cfgh'
const advisory = (severity = 'high', id = otherId) => ({
  severity,
  github_advisory_id: id,
  url: `https://github.com/advisories/${id}`,
  module_name: 'example',
})
const report = (...entries) => ({ advisories: Object.fromEntries(entries.map((entry, i) => [i, entry])) })
const exempt = advisory('high', exemptId)

function run(input, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}

for (const [name, input, code] of [
  ['no vulnerabilities', report(), 0],
  ['only the approved exemption', report(exempt), 0],
  ['exemption does not hide another high (r2)', report(exempt, advisory()), 1],
  ['exemption does not hide another critical', report(exempt, advisory('critical')), 1],
  ['high without exemption', report(advisory()), 1],
  ['critical without exemption', report(advisory('critical')), 1],
  ['all lower severities', report(...['info', 'low', 'moderate'].map((severity) => advisory(severity))), 0],
  ['exemption with lower severities', report(exempt, advisory('low'), advisory('moderate')), 0],
  ['exemption uses ID alone', report({ severity: 'high', github_advisory_id: exemptId }), 0],
  ['exemption uses exact URL alone', report({ severity: 'high', url: exemptUrl }), 0],
  ['other URL alone cannot be exempt', report({ severity: 'high', url: advisory().url }), 1],
  ['lower severity with URL alone', report({ severity: 'low', url: advisory().url }), 0],
  ['advisories is a number (r3)', { advisories: 1 }, 1],
  ['missing severity (r3)', report({ github_advisory_id: otherId }), 1],
  ['error with empty advisories (r3)', { error: { code: 'ERR_PNPM_AUDIT' }, advisories: {} }, 1],
  ['pnpm error without advisories', { error: { code: 'ERR_PNPM_AUDIT' } }, 1],
  ['missing advisories', {}, 1],
  ['missing identity even at low severity', report({ severity: 'low' }), 1],
  ['malformed entry after exemption', report(exempt, { github_advisory_id: otherId }), 1],
  ['malformed exempt entry is not skipped', report({ github_advisory_id: exemptId }), 1],
  ['unknown severity is not skipped for exempt ID', report(advisory('unknown', exemptId)), 1],
  ['conflicting ID cannot borrow exempt URL', report({ ...advisory(), url: exemptUrl }), 1],
  ['conflicting URL cannot borrow exempt ID', report({ ...exempt, url: advisory().url }), 1],
]) {
  test(name, () => {
    const result = run(JSON.stringify(input))
    assert.equal(result.status, code, result.stdout + result.stderr)
  })
}

for (const input of ['', '   ', 'not JSON', '{', '{"advisories":{}} trailing']) {
  test(`rejects invalid JSON: ${JSON.stringify(input)}`, () => {
    assert.equal(run(input).status, 1)
  })
}

for (const value of [null, [], 1, true, 'text']) {
  for (const [name, input] of [
    ['report', value],
    ['advisories', { advisories: value }],
    ['advisory', report(value)],
  ]) {
    test(`rejects ${name}: ${JSON.stringify(value)}`, () => {
      assert.equal(run(JSON.stringify(input)).status, 1)
    })
  }
}

for (const error of [null, false, 0, '', [], {}]) {
  test(`rejects presence of error even when falsy: ${JSON.stringify(error)}`, () => {
    assert.equal(run(JSON.stringify({ error, advisories: {} })).status, 1)
  })
}

for (const severity of [null, 0, [], {}, '', 'HIGH', 'unknown']) {
  test(`rejects invalid severity: ${JSON.stringify(severity)}`, () => {
    assert.equal(run(JSON.stringify(report(advisory(severity)))).status, 1)
  })
}

for (const field of ['github_advisory_id', 'url']) {
  for (const value of [null, 1, [], {}, '', '   ']) {
    test(`rejects malformed ${field} even alongside exempt identity: ${JSON.stringify(value)}`, () => {
      assert.equal(run(JSON.stringify(report({ ...exempt, [field]: value }))).status, 1)
    })
  }
}

for (const url of [
  `https://example.com/advisories/${exemptId}`,
  `${exemptUrl}/other`,
  `${advisory().url}?ref=${exemptId}`,
  `https://github.com.example.com/advisories/${exemptId}`,
]) {
  test(`URL resemblance cannot grant exemption: ${url}`, () => {
    assert.equal(run(JSON.stringify(report({ severity: 'high', url }))).status, 1)
  })
}

test('prints the exempt and blocked entries and a nonzero summary', () => {
  const result = run(JSON.stringify(report(exempt, advisory())))
  assert.equal(result.status, 1)
  assert.match(result.stdout, /豁免 high GHSA-vfj7-8cjw-p6xm/)
  assert.match(result.stdout, /FAIL high GHSA-2345-6789-cfgh/)
  assert.match(result.stdout, /2 條 advisory，1 條未豁免的 high／critical/)
})

test('reads the file argument used by CI and fails for missing files', (t) => {
  const dir = mkdtempSync('/tmp/rv-566-audit-gate-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'audit.json')
  writeFileSync(file, JSON.stringify(report(exempt)))
  assert.equal(run('', [file]).status, 0)
  writeFileSync(file, JSON.stringify(report(exempt, advisory())))
  assert.equal(run('', [file]).status, 1)
  assert.equal(run('', [join(dir, 'missing.json')]).status, 1)
})
