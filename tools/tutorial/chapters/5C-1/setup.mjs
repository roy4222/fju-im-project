#!/usr/bin/env node
// 5C-1 段首準備（在 reset.sh 之後跑）：seed 沒有「專題發表」的指派，G04 沒有最終成績可以更正。
// 走網站自己的 UI：系辦把 G04「專題發表」設成需要 1 位老師、指派陳建宏；陳建宏填完正式送出。
//   INSTANCE=4 node tools/tutorial/chapters/5C-1/setup.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const INSTANCE = process.env.INSTANCE ?? '4'
const BASE = `http://localhost:${3300 + Number(INSTANCE)}`
const ENV = path.join(import.meta.dirname, '../../env')
const { chromium } = createRequire(path.join(import.meta.dirname, '../../package.json'))('playwright')

function account(name) {
  const file = path.join(os.homedir(), 'work/tutorial-secrets', INSTANCE === '0' ? 'accounts.json' : `accounts-${INSTANCE}.json`)
  const acc = JSON.parse(fs.readFileSync(file, 'utf8')).accounts.find((a) => a.name === name)
  if (!acc) throw new Error(`帳號設定裡沒有 ${name}`)
  const list = execFileSync('node', [path.join(ENV, 'accounts.mjs'), 'list'], { env: { ...process.env, INSTANCE }, encoding: 'utf8' })
  const email = acc.email ?? list.split('\n').map((l) => l.trim().split(/\s+/)).find((c) => c[1] === name)?.[2]
  return { email, password: acc.password }
}

async function login(browser, name) {
  const page = await browser.newPage()
  page.setDefaultTimeout(15_000)
  const { email, password } = account(name)
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))
  return page
}

const browser = await chromium.launch()
try {
  const admin = await login(browser, '系辦管理員')
  await admin.goto(`${BASE}/dashboard/admin/grading?dialog=assign`)
  await admin.getByRole('navigation', { name: '選擇階段' }).getByRole('link', { name: '專題發表' }).click()
  const row = admin.getByTestId('grading-row-G04')
  await row.getByLabel('G04「專題發表」需要幾位老師評分').fill('1')
  await row.getByRole('button', { name: '儲存' }).click()
  await row.getByText(/已正式送出 0／1 份/).waitFor()
  await row.getByLabel('G04「專題發表」評分老師').selectOption({ label: '陳建宏' })
  await row.getByRole('button', { name: '指派' }).click()
  await row.getByText('陳建宏').first().waitFor()
  console.log('[5C-1 setup] G04「專題發表」需要 1 位、已指派陳建宏')

  const teacher = await login(browser, '陳建宏')
  await teacher.goto(`${BASE}/dashboard/teacher/grading`)
  await teacher.getByRole('list', { name: '待評分清單' }).getByRole('link', { name: /專題發表 G04/ }).click()
  await teacher.getByRole('textbox', { name: /^1\. / }).fill('88')
  await teacher.getByRole('textbox', { name: /^2\. / }).fill('84')
  await teacher.getByRole('button', { name: '正式送出' }).click()
  await teacher.getByRole('dialog').getByRole('button', { name: '確認送出' }).click()
  await teacher.getByRole('dialog', { name: '已送出' }).waitFor()
  console.log('[5C-1 setup] 陳建宏已正式送出 G04「專題發表」，G04 有最終成績')

  await admin.goto(`${BASE}/dashboard/admin/grading`)
  const final = await admin.getByRole('table', { name: '成績表' }).getByRole('row').filter({ hasText: /^G04/ }).innerText()
  if (/尚未完成\s*計算明細|尚未完成\s*$/.test(final.split('\t').slice(0, 4).join('\t'))) throw new Error(`G04 還沒有最終成績：${final}`)
  console.log(`[5C-1 setup] 成績表 G04：${final.replace(/\s+/g, ' ')}`)
} finally {
  await browser.close()
}
