#!/usr/bin/env node
// 5A-5 段首準備（在 reset.sh 之後跑）：產生批次指派 CSV 到 ~/work/tutorial-out/chapters/5A-5/fixtures/assign.csv（不進 repo）。
// 欄名照頁面範例檔（group_code,teacher_login_email），2 列：
//   G09 → 陳建宏（5A-5-4 已先把 G09 指派給王雅玲，所以這列算「屬於重派」）
//   G01 → 王雅玲（G01 本來就是王雅玲，算「不需變更」）
// 老師的登入 Email 不寫死：以系辦身分打開 G09 的「指派指導老師」對話框，從選單讀出來（只讀、不送出）。
//   INSTANCE=3 node tools/tutorial/chapters/5A-5/setup.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const INSTANCE = process.env.INSTANCE ?? '3'
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

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const { email, password } = account('系辦管理員')
  await page.goto(`${BASE}/login`)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('密碼').fill(password)
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))

  await page.goto(`${BASE}/dashboard/admin/groups`)
  await page.getByRole('button', { name: '指派指導老師：G09' }).click()
  const options = await page.getByRole('dialog').getByRole('combobox', { name: '指導老師' }).locator('option').allInnerTexts()
  const loginEmail = (name) => {
    const m = options.find((o) => o.startsWith(`${name}（`))?.match(/（(.+)）$/)
    if (!m) throw new Error(`指派選單裡找不到 ${name}（G09 可能已經指派過；先跑 reset.sh）`)
    return m[1]
  }
  const dir = path.join(os.homedir(), 'work/tutorial-out/chapters/5A-5/fixtures')
  fs.mkdirSync(dir, { recursive: true })
  const csv = ['group_code,teacher_login_email', `G09,${loginEmail('陳建宏')}`, `G01,${loginEmail('王雅玲')}`].join('\n') + '\n'
  fs.writeFileSync(path.join(dir, 'assign.csv'), csv)
  console.log(`[5A-5 setup] 批次指派 CSV 已放在 ${dir}`)
} finally {
  await browser.close()
}
