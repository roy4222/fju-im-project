// 錄影 1（0、3-1～3-5）共用的小工具：實例網址、帳號、登入、跑一段錄影。
// 密碼只從本機 ~/work/tutorial-secrets/accounts[-n].json 讀，不進 repo。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../../engine/index.ts';

export const INSTANCE = Number(process.env.INSTANCE ?? '1');
export const BASE_URL = `http://localhost:${3300 + INSTANCE}`;
export const DISPLAY_ORIGIN = 'test.fju.roy422.dev';
export const OUT_ROOT = path.join(os.homedir(), 'work', 'tutorial-out', 'chapters');

type Account = { role: string; name: string; email?: string; password: string };

function accounts(): Account[] {
  const file = path.join(os.homedir(), 'work', 'tutorial-secrets', INSTANCE === 0 ? 'accounts.json' : `accounts-${INSTANCE}.json`);
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { accounts: Account[] }).accounts;
}

/** 示範帳號的登入 Email：設定檔有寫就用，沒有就問 accounts.mjs list 印出的對照（學生是學號@demo.invalid）。 */
const EMAILS: Record<string, string> = {
  系辦管理員: 'office-admin@demo.invalid',
  林彥廷: '411410123@demo.invalid',
  鄭凱文: '411410201@demo.invalid',
  應宥丞: '411410411@demo.invalid',
  鞠柏宇: '411410433@demo.invalid',
  冷佳霓: '411410444@demo.invalid',
  陳建宏: 'chen.ch@demo.invalid',
  李孟儒: 'lee.mj@demo.invalid',
  黃詩涵: '411410145@demo.invalid',
};

export function credentials(name: string): { email: string; password: string } {
  const a = accounts().find((x) => x.name === name);
  if (!a) throw new Error(`教學帳號設定裡沒有「${name}」`);
  const email = a.email ?? EMAILS[name];
  if (!email) throw new Error(`不知道「${name}」的登入帳號`);
  return { email, password: a.password };
}

/** 清 cookie 後用 API 登入（cookie 寫進這個分頁的 context），再開 `home`。 */
export async function loginAs(page: Page, name: string, home?: string): Promise<void> {
  const ctx = page.context();
  await ctx.clearCookies();
  const { email, password } = credentials(name);
  const res = await ctx.request.post(`${BASE_URL}/api/auth/sign-in/email`, {
    headers: { origin: BASE_URL },
    data: { email, password },
  });
  if (!res.ok()) throw new Error(`「${name}」登入失敗（${res.status()}）`);
  if (home) await page.goto(`${BASE_URL}${home}`, { waitUntil: 'networkidle' });
}

/** 跑一段錄影：開瀏覽器、startChapter、跑劇本、finish、render，成品複製到 ~/work/tutorial-out/chapters/<id>/<id>.mp4。 */
export async function recordChapter(
  opts: { id: string; chapter: string; subtitle?: string },
  script: (t: Chapter, page: Page, browser: Browser) => Promise<void>,
): Promise<void> {
  if (process.env.DRY_RUN) return dryRun(opts, script);
  const browser = await launchTutorialBrowser();
  let chapter: Chapter | undefined;
  try {
    const page = await newTutorialPage(browser);
    const t = (chapter = await startChapter({ page, ...opts, baseURL: BASE_URL, displayOrigin: DISPLAY_ORIGIN }));
    console.log(`run 目錄：${t.outDir}`);
    await script(t, page, browser);
    await t.finish();
  } finally {
    await chapter?.dispose();
    await browser.close();
  }
  const dir = chapter!.outDir;
  await renderChapter({ dir });
  const dest = path.join(OUT_ROOT, opts.id);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(dir, 'chapter.mp4'), path.join(dest, `${opts.id}.mp4`));
  fs.copyFileSync(path.join(dir, 'events.json'), path.join(dest, 'events.json'));
  fs.writeFileSync(path.join(dest, 'run-dir.txt'), `${dir}\n`);
  console.log(`成品：${path.join(dest, `${opts.id}.mp4`)}`);
}

/**
 * DRY_RUN=1：不錄影、不佔名額，用無頭 Chromium（CSS 1280×587）照劇本把每個動作做一次，
 * 只驗證定位器找得到、流程走得通；每一步結束截一張圖到 /tmp/tutorial-dry/<id>/。
 */
async function dryRun(
  opts: { id: string; chapter: string },
  script: (t: Chapter, page: Page, browser: Browser) => Promise<void>,
): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const shots = path.join(os.tmpdir(), 'tutorial-dry', opts.id);
  fs.rmSync(shots, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 587 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    const page = await ctx.newPage();
    let n = 0;
    let caption = '';
    const settle = async () => {
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(400);
    };
    const visible = async (l: Locator) => {
      await l.waitFor({ state: 'visible', timeout: 5000 }).catch((e) => {
        throw new Error(`［${caption}］5 秒內找不到 ${l}`, { cause: e });
      });
    };
    const t = {
      offRecord: async <T>(fn: () => Promise<T>) => fn(),
      waitStable: async (o: { ready?: Locator | string } = {}) => {
        if (o.ready) await visible(typeof o.ready === 'string' ? page.getByText(o.ready).first() : o.ready);
        await settle();
      },
      step: async (o: { caption: string }, fn: () => Promise<void>) => {
        caption = o.caption;
        n += 1;
        await fn();
        await settle();
        await page.screenshot({ path: path.join(shots, `${String(n).padStart(2, '0')}.png`) });
        console.log(`✓ ${n}. ${o.caption}`);
      },
      click: async (l: Locator) => {
        await visible(l);
        await l.click();
        await settle();
      },
      hover: async (l: Locator) => {
        await visible(l);
        await l.hover();
      },
      type: async (l: Locator, text: string) => {
        await visible(l);
        await l.click();
        await l.pressSequentially(text);
      },
      press: async (key: string) => page.keyboard.press(key),
      select: async (l: Locator, v: string) => {
        await visible(l);
        await l.selectOption(v);
      },
      upload: async (l: Locator, file: string, o: { via?: Locator } = {}) => {
        if (o.via) await visible(o.via);
        await l.setInputFiles(file);
      },
      scroll: async (x: number | Locator) => {
        if (typeof x === 'number') await page.mouse.wheel(0, x);
        else {
          await visible(x);
          await x.scrollIntoViewIfNeeded();
        }
      },
      wait: async (ms: number) => page.waitForTimeout(ms),
      goto: async (p: string) => {
        await page.goto(p.startsWith('http') ? p : `${BASE_URL}${p}`);
        await settle();
      },
    };
    await script(t as unknown as Chapter, page, browser);
    console.log(`DRY_RUN 完成：${opts.id}，${n} 步，截圖在 ${shots}`);
  } finally {
    await browser.close();
  }
}
