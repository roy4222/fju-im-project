#!/usr/bin/env node
// 4-3 段首準備（在 reset.sh 之後跑）：以系辦身分把陳建宏對 G04「系統驗收」的正式評分退回，
// 讓 4-3-10 有一份「已退回」可操作。走網站自己的 UI（跟 5C-1-10 同一個按鈕），不直接寫資料庫。
//   INSTANCE=3 node tools/tutorial/chapters/4-3/setup.mjs
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

  await page.goto(`${BASE}/dashboard/admin/grading`)
  await page.getByRole('row').filter({ hasText: /^G04/ }).getByRole('link', { name: '計算明細' }).click()
  await page.getByRole('heading', { name: 'G04 計算明細' }).waitFor()
  await page.getByRole('button', { name: '退回 陳建宏 老師的「系統驗收」評分' }).click()
  const dialog = page.getByRole('dialog', { name: '退回評分' })
  await dialog.getByLabel('退回理由（老師看得到）').fill('請補系統展示項目的說明')
  await dialog.getByRole('button', { name: '確認退回' }).click()
  await page.getByRole('button', { name: '退回 陳建宏 老師的「系統驗收」評分' }).waitFor({ state: 'detached' })
  console.log('[4-3 setup] 已退回陳建宏對 G04「系統驗收」的評分')
} finally {
  await browser.close()
}
