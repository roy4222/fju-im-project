#!/usr/bin/env node
// 5C-4 段首準備（在 reset.sh 之後跑）：讓操作紀錄有核准註冊、恢復帳號、新增屆別三種管理操作，系辦通知匣有一則示範 114 屆的通知。
// 走網站自己的 UI：核准陳冠宇（當面核對學生證）、恢復郭安琪（理由：教學示範）、新增示範 115 屆；再用「發一則測試通知」發給系辦自己（屆別選示範 114 屆），等背景工作送進通知匣。
//   INSTANCE=4 node tools/tutorial/chapters/5C-4/setup.mjs
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

  await admin.goto(`${BASE}/dashboard/admin/accounts`)
  await admin.getByRole('button', { name: '審核 陳冠宇' }).first().click()
  const review = admin.getByRole('dialog', { name: '審核 陳冠宇' })
  await review.getByText(/學生證/).first().click()
  await review.getByRole('button', { name: /^核准/ }).click()
  await review.getByText(/^已開通/).waitFor()
  console.log('[5C-4 setup] 已核准陳冠宇（當面核對學生證）')

  await admin.goto(`${BASE}/dashboard/admin/accounts?status=disabled`)
  await admin.getByRole('button', { name: '恢復 郭安琪' }).first().click()
  const restore = admin.getByRole('dialog', { name: '恢復 郭安琪' })
  await restore.getByLabel(/^理由/).fill('教學示範')
  await restore.getByRole('button', { name: '確認恢復' }).click()
  await restore.getByText('已恢復', { exact: true }).waitFor()
  console.log('[5C-4 setup] 已恢復郭安琪（理由：教學示範）')

  await admin.goto(`${BASE}/dashboard/admin/cohorts`)
  await admin.getByLabel('代碼', { exact: true }).fill('DEMO-115')
  await admin.getByLabel('名稱', { exact: true }).fill('示範 115 屆')
  await admin.getByRole('button', { name: '新增屆別' }).click()
  await admin.getByText('DEMO-115').first().waitFor()
  console.log('[5C-4 setup] 已新增屆別示範 115 屆（DEMO-115）')

  await admin.goto(`${BASE}/dashboard/admin/inbox`)
  const form = admin.locator('form').filter({ has: admin.getByRole('button', { name: '發送測試通知' }) })
  const recipient = form.getByLabel('收件人')
  await recipient.selectOption(await recipient.locator('option', { hasText: '系辦管理員' }).getAttribute('value'))
  await form.getByLabel('屆別').selectOption({ label: '示範 114 屆（DEMO-114）' })
  await form.getByLabel(/^標題/).fill('示範：成績更正需要重新確認')
  await form.getByRole('button', { name: '發送測試通知' }).click()
  await admin.getByText(/^已發給/).waitFor()
  for (let i = 0; ; i++) {
    await admin.goto(`${BASE}/dashboard/admin/inbox`)
    if (await admin.getByRole('main').getByRole('link', { name: /示範 114 屆（DEMO-114）/ }).count()) break
    if (i > 30) throw new Error('等了 60 秒，背景工作還沒把通知送進系辦通知匣')
    await admin.waitForTimeout(2000)
  }
  console.log('[5C-4 setup] 系辦通知匣已有示範 114 屆的通知')
} finally {
  await browser.close()
}
