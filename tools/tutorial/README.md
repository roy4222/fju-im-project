# 教學影片引擎（tools/tutorial）

照劇本用 Playwright 操作瀏覽器、錄**乾淨畫面**（沒有真游標），同時記下每個動作的時間與座標；後製再加上平滑游標、點擊波紋、步驟字幕、章節標題卡、假網址列、狀態標記與繁中配音，最後把各章接成一部片。

- 劇本作者只需要 `engine/index.ts` 匯出的 API。
- 分鏡與功能表：`storyboard.md`、`feature-table.md`（另有負責人）；測試環境：`env/`。

## 需求

macOS（`say` 配音）、Node ≥ 22.18（直接跑 `.ts`）、`ffmpeg`／`ffprobe`（需含 libx264、libass）、Playwright Chromium。

```sh
pnpm install                         # 在 repo 根目錄
pnpm -C tools/tutorial exec playwright install chromium
```

> 錄影會開**有視窗的 Chromium**（`launchTutorialBrowser()` 預設），錄影期間不要動那個視窗。
>
> **網頁放大 1.5 倍**：視窗內容區是 CSS 1280×667，用 `--force-device-scale-factor=1.5` 以實際 1920×1000 像素渲染，網頁正文 15px 在 1080p 裡約 22px（手機、筆電上也看得清楚），版面仍是桌機版。影格用 CDP 連續截圖取得（Mac mini 上每秒約 30～38 張）。不用 Playwright 的 `deviceScaleFactor` 模擬：模擬時 screencast 與截圖都只給 CSS 大小的影格；另開 session 設裝置參數雖能截到 1920 寬，滑鼠座標卻會被多除一次 1.5。所以分頁一定要用 `launchTutorialBrowser()`＋`newTutorialPage()` 開（`startChapter` 偵測到 viewport 模擬會直接報錯）。

## 寫一章劇本

```ts
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter } from '../engine/index.ts';

const browser = await launchTutorialBrowser();
const page = await newTutorialPage(browser);
const t = await startChapter({ page, outDir: 'out/03-student', chapter: '學生｜繳交作業', number: 3, baseURL: 'http://localhost:3000', displayOrigin: 'test.fju.roy422.dev' });
await t.offRecord(() => loginAs(page, 'student'));          // 不進影片：登入、準備資料（自己的輔助函式）
await t.step({ caption: '打開作業頁', narration: '登入後，從左側選單進入專題事務的作業頁。', status: 'warn', note: '截止提醒尚未實作' }, async () => {
  await t.click(page.getByRole('link', { name: '作業' }));
  await t.upload(page.locator('input[type=file]'), 'fixtures/report.pdf', { via: page.getByRole('button', { name: '選擇檔案' }) });
});
await t.finish(); await browser.close();
await renderChapter({ dir: 'out/03-student' });              // → out/03-student/chapter.mp4
```

### `startChapter(options)`

| 選項 | 說明 |
|---|---|
| `page` | `newTutorialPage(browser)` 開的分頁（CSS 1280×667 ×1.5 ＝ 影片頁面區 1920×1000，上方留 80px 給假網址列）。 |
| `outDir` | 這一章的輸出資料夾。 |
| `chapter`、`number`、`subtitle` | 標題卡顯示「`number`｜`chapter` 第一段」＋副標（預設取 `｜` 之後）。章節全名是 `3｜學生｜繳交作業`。 |
| `baseURL` | `t.goto('/x')` 的基準。 |
| `displayOrigin` | 假網址列顯示的主機（本機錄影時填 `test.fju.roy422.dev`）。 |
| `tts` | 配音 provider，預設 `sayProvider({ voice: 'Meijia', rate: 190 })`。 |

### `t.step({ caption, narration, status, note }, fn)`

- `caption`：字幕（短）。`narration`：配音（完整句子，可以比字幕長）。
- `status`：`'ok' | 'warn' | 'bad' | 'pending'` → ✅ ⚠️ ❌ 🟡，`note` 是旁邊那句說明；只在這一步出現在右上角。
- **節奏由配音決定**：先合成配音（合成時間不進影片），配音在步驟開始 250 ms 後起播，`fn` 裡的動作同時進行；步驟長度至少「配音長度＋0.6 秒」，動作比配音久就照動作。
- 步驟不能巢狀。

### 動作

| 動作 | 行為 |
|---|---|
| `t.click(locator)` | 目標不在安全區（網址列下、字幕條上）就先平滑捲動；游標以緩動移過去（600～900 ms，速度上限 2.4 px/ms），停 150 ms 再按，畫面出現橘色波紋。 |
| `t.type(locator, text, { secret })` | 先點進欄位，再逐字輸入（每字 60～130 ms，固定種子，每次一樣）。`secret: true` 時 events.json 只記遮罩。 |
| `t.select(locator, value)` | 原生下拉：游標移過去＋波紋，直接選值（原生彈出層錄不到）。自訂下拉請用兩次 `t.click`。 |
| `t.upload(locator, file, { via })` | file input 多半隱藏，`via` 指定游標要點的按鈕。 |
| `t.scroll(px \| locator)` | 平滑捲動（數字是網頁 CSS px）；給 locator 會把它捲到畫面上方三分之一。 |
| `t.hover(locator)`、`t.wait(ms)`、`t.goto(path)` | 移過去不點／停一下／換頁（等到 load＋最多 3 秒 networkidle）。 |
| `t.offRecord(fn)` | `fn` 期間的畫面不進影片，結束後直接切到當下畫面。開頭先 `t.offRecord(() => t.goto('/'))` 可以略過白畫面載入。 |

找不到元素時 5 秒內失敗，錯誤訊息帶步驟字幕；目標捲不出字幕條範圍會在指令列警告。

只對測試站操作公開頁或專用測試帳號；需要登入、送出表單的章節請用 `env/` 的本機環境。

## 後製與組裝

```sh
node engine/cli.ts render out/03-student [--out 03.mp4]            # 一章 → 1920×1080 30fps H.264＋AAC
node engine/cli.ts assemble --out out/final --features feature-table.md out/01-visitor out/03-student …
```

`render` 圖層由下到上：白底 → 錄到的頁面（在網址列下方）→ Chromium 畫的透明 PNG（假網址列＋狀態標記、字幕條；開頭 2.5 秒是標題卡）→ ASS（點擊波紋、帶陰影的 macOS 樣式游標）；配音依各步起播時間混成一軌。中文用 PingFang TC（退回 Noto Sans TC），emoji 用 Apple Color Emoji。主色 `#E56E00` 取自 `web/src/app/globals.css` 的 `--primary`。

`assemble` 輸出：

- `final.mp4`：影像直接接、聲音重新編一次（避免章節交界的 AAC 空隙）；章節起點照**實際檔案長度**排。
- `youtube-description.txt`：貼到 YouTube 說明欄。開頭 `{{INTRO}}`（簡介，之後填）＋圖例（✅⚠️❌🟡 各一句）＋章節時間軸：**每段一行**，例如 `3:12 學生｜繳交作業：上傳檔案、送出、看版本、補交`，冒號後是 feature-table「功能」欄裡指到這一章的功能（依影片時間排、頓號接、超過 90 字截斷加「…」；沒有功能表就用步驟字幕）。第一行 `0:00`、時間碼遞增、不足 10 秒的段併到相鄰段，總字數 < 4500（超過會再縮短每段清單）。**不放每一步的時間碼**，否則 YouTube 不顯示章節列。少於 3 段會在指令列警告。
- `feature-timeline.md`：每個 F 編號一行，時間碼＋`https://youtu.be/{{VIDEO_ID}}?t=<秒>` 連結（上傳後把 `{{VIDEO_ID}}` 換掉）；影片裡沒示範的列會標出來。
- `index.html`：左邊影片、右邊章節／步驟與功能清單，點時間碼就跳過去。功能清單讀 `feature-table.md` 的 Markdown 表格，「章節與步驟」欄接受 `3-2`、`3.2`、`3｜2`、`第 3 章步驟 2`、`3`（整章）與用頓號分隔的多筆；對不到影片的列會警告。
- `timeline.json`：每章起點與步驟時間（機器讀）。

## 錄影輸出 `events.json`

時間一律是**章節影片時間**（ms，`clip.mp4` 第 0 格＝0），座標是 clip 影片像素（不含網址列）。

```jsonc
{
  "chapter": "學生｜繳交作業", "number": 3,
  "clip": { "file": "clip.mp4", "durationMs": 55400, "fps": 30, "captureLatencyMs": 10 },
  "steps": [{ "index": 1, "caption": "…", "narration": "…", "status": { "kind": "warn", "note": "…" },
              "startMs": 0, "endMs": 9288, "audio": { "file": "audio/step-01.wav", "startMs": 250, "durationMs": 8436 } }],
  "events": [{ "type": "move", "startMs": 300, "endMs": 1100, "from": {…}, "to": {…} },
             { "type": "click", "atMs": 1300, "x": 400, "y": 300 },
             { "type": "url", "atMs": 1600, "url": "https://…" }]   // 另有 type、select、upload、scroll
}
```

### 時間怎麼對齊

錄影用 CDP 連續截圖，每張影格記請求前後的中點時間，自己排成固定 30fps（每格取不晚於格位中點的最新影格），再以 image2 固定 30fps 讀進 ffmpeg（不經過 fps 換算），所以影片時間與事件時間用同一個時鐘。配音合成與 `offRecord` 期間時鐘暫停、影格丟掉（只留暫停中最後一張當恢復時的畫面）。每章開頭在暫停中閃 0.7 秒時間條碼，量「畫面內容 → 截圖」的延遲（`captureLatencyMs`）並扣掉。

## 測試

```sh
pnpm -C tools/tutorial test        # 需要 macOS 有畫面的工作階段（會開 Chromium 視窗）與 ffmpeg
pnpm -C tools/tutorial typecheck
```

- `cursor.test.ts`：每段 600～900 ms、逐格速度不超過上限、緩動起訖。
- `recorder.test.ts`：頁面每格畫出章節時間的二進位條碼，從 `clip.mp4` 逐格解碼 → 每個新數值第一次出現的影片時間與它的章節時間差 ≤ 50 ms（1.5 倍放大下實測中位數約 7 ms、最大約 16～21 ms），點擊事件與按鈕變色的第一格差 ≤ 50 ms，點擊座標換算正確、clip 是 1920×1000 實際像素，步驟長度 ≥ 配音＋0.6 秒（含一次中途暫停）。
- `render.test.ts`：合成一章實際 render，檢查格式（H.264 1920×1080 30fps＋AAC）、標題卡、網址列、字幕條、游標位置、波紋圓心與配音音量。
- `assemble.test.ts`：說明欄的 YouTube 規則（第一行 0:00、時間碼遞增、間隔 ≥ 10 秒、總字數上限、90 字截斷、短段合併）、功能時間軸連結、功能表解析與 index.html 時間碼。

## 格式樣片

```sh
node engine/samples/visitor-sample.ts [輸出資料夾]   # 預設 ~/work/tutorial-out → sample-visitor.mp4
```

只讀 https://test.fju.roy422.dev 的公開頁（`/`、`/news`、`/projects/featured`、`/honors`），不登入、不輸入、不送出表單。
