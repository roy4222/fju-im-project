#!/usr/bin/env node
// 5C-2 段首準備（在 reset.sh 之後跑）：seed 的 G09 沒有指導老師，不能替 G09 建同意書。
// 走網站自己的 UI：系辦在分組總覽替 G09 指派王雅玲為指導老師。
//   INSTANCE=4 node tools/tutorial/chapters/5C-2/setup.mjs
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
  await admin.goto(`${BASE}/dashboard/admin/groups`)
  await admin.getByRole('button', { name: '指派指導老師：G09' }).click()
  const d = admin.getByRole('dialog', { name: '指派 G09 的指導老師' })
  const teacher = d.getByLabel('指導老師')
  await teacher.selectOption(await teacher.locator('option', { hasText: '王雅玲' }).getAttribute('value'))
  await d.getByLabel('理由（必填）').fill('教學示範：替 G09 指派指導老師')
  await d.getByRole('button', { name: '確認指派' }).click()
  await d.waitFor({ state: 'hidden' })
  await admin.goto(`${BASE}/dashboard/admin/signoff`)
  await admin.getByRole('button', { name: '新增站內同意書' }).click()
  const n = admin.getByRole('dialog', { name: '新增站內同意書' })
  await n.getByLabel('組別').selectOption({ label: 'G09' })
  const who = await n.getByTestId('impact-preview').innerText()
  if (!who.includes('王雅玲')) throw new Error(`G09 的同意書參與者沒有王雅玲：${who}`)
  console.log(`[5C-2 setup] G09 指導老師已指派王雅玲（${who.split('\n')[0]}）`)
} finally {
  await browser.close()
}
