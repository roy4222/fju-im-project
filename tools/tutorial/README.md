# 教學影片引擎（tools/tutorial）

照劇本用 Playwright 操作瀏覽器、錄**乾淨畫面**（沒有真游標），同時記下每個動作的時間與座標；後製再加上平滑游標、點擊波紋、步驟字幕、章節標題卡、假網址列、狀態標記與繁中配音，最後把各章接成一部片。

- 劇本作者只需要 `engine/index.ts` 匯出的 API。
- 分鏡與功能表：`storyboard.md`、`feature-table.md`（另有負責人）；測試環境：`env/`。

## 需求

macOS（`say` 配音）、Node ≥ 22.18（直接跑 `.ts`）、`ffmpeg`／`ffprobe`（需含 libx264、libass）、Playwright Chromium。用 Gemini 配音時另需 OpenRouter 金鑰：放在鑰匙圈 `OPENROUTER_API_KEY`（`security add-generic-password -s OPENROUTER_API_KEY -a $USER -w`），引擎只在快取沒命中時讀，不印、不寫檔。

```sh
pnpm install                         # 在 repo 根目錄
pnpm -C tools/tutorial exec playwright install chromium
```

> 錄影會開**有視窗的 Chromium**（`launchTutorialBrowser()` 預設），錄影期間不要動那個視窗。
>
> **版面**：1920×1080 的影片由上到下是假網址列 80px、**頁面區 1920×880**、**字幕帶 120px**。字幕、按鍵提示、狀態標記都在頁面區外，網頁內容永遠不會被蓋住（對話框最底下的「下一步／發布」、表單最底下的「儲存草稿」都點得到、看得到）。
>
> **網頁放大 1.5 倍**：視窗內容區是 CSS 1280×587（寬維持 1280 的桌機版面），用 `--force-device-scale-factor=1.5` 以實際 1920×880 像素渲染，網頁正文 15px 在 1080p 裡約 22px（手機、筆電上也看得清楚）。影格用 CDP 連續截圖取得（Mac mini 上每秒約 30～48 張）。不用 Playwright 的 `deviceScaleFactor` 模擬：模擬時 screencast 與截圖都只給 CSS 大小的影格；另開 session 設裝置參數雖能截到 1920 寬，滑鼠座標卻會被多除一次 1.5。所以分頁一定要用 `launchTutorialBrowser()`＋`newTutorialPage()` 開（`startChapter` 偵測到 viewport 模擬會直接報錯）。

## 寫一段劇本

```ts
import { launchTutorialBrowser, newTutorialPage, renderChapter, startChapter, type Chapter } from '../engine/index.ts';

const browser = await launchTutorialBrowser();
let chapter: Chapter | undefined;
try {
  const page = await newTutorialPage(browser);
  const t = (chapter = await startChapter({ page, id: '3-3', chapter: '學生｜繳交作業', baseURL: 'http://localhost:3000', displayOrigin: 'test.fju.roy422.dev' }));
  await t.offRecord(() => loginAs(page, 'student'));          // 不進影片：登入、準備資料（環境提供的輔助函式）
  await t.step({ caption: '打開作業頁', narration: '登入後，從左側選單進入專題事務的作業頁。', status: { kind: 'warn', say: '截止提醒還沒做', evidence: 'story-2 第 39 步' } }, async () => {
    await t.click(page.getByRole('link', { name: '作業' }));  // 換頁會自動等新頁穩定（不進影片）
    await t.upload(page.locator('input[type=file]'), 'fixtures/report.pdf', { via: page.getByRole('button', { name: '選擇檔案' }) });
    await t.waitStable({ ready: 'report.pdf' });               // 等畫面穩定：一律不進影片，逾時也只留警告
    await t.type(page.getByRole('searchbox'), '期中');
    await t.press('Enter');                                    // 畫面上出現「⏎ Enter」鍵帽提示 0.8 秒
  });
  await t.finish();
} finally {
  await chapter?.dispose();   // 失敗也要清：停止截圖、歸還錄影名額、留下 FAILED.txt
  await browser.close();
}
await renderChapter({ dir: chapter!.outDir });               // → <run 目錄>/chapter.mp4
```

## 錄影實作者須知

1. **一律用 `launchTutorialBrowser()`＋`newTutorialPage(browser)` 開分頁**。它們設好 1.5 倍放大（CSS 1280×587 → 1920×880 實際像素的頁面區）、繁中、台北時區。自己 `chromium.launch()` 或 `browser.newPage({ viewport })` 會得到 CSS 大小的模糊影格，`startChapter` 會直接報錯。錄影時會開一個 Chromium 視窗，不要動它、不要蓋住它。
2. **每段一個獨立 run 目錄**。`startChapter` 不給 `outDir` 時自動建 `~/work/tutorial-out/runs/<段編號>-<章名>-<時間>-<亂碼>/`（印在 `t.outDir`）；給 `outDir` 的話它必須還不存在，已存在就立刻拒絕（不會覆蓋別人的錄影）。錄影中目錄裡有 `.recording`；失敗會留下 `FAILED.txt`，這兩種目錄 `render` 都會拒絕。`id` 填分鏡的段編號（`1-3`、`5A-2`），feature-table 的「章節與步驟」靠它對時間。
3. **錄影名額：同一台機器預設同時只錄 1 路**（第 2 輪定案：Mac mini 2 路同時錄時截圖間隔多次 100～639 ms；名額是 `~/work/tutorial-out/.record-slots/` 裡的鎖檔，用作業系統的檔案鎖）。第 2 路起在 `startChapter` 排隊並印「等待錄影名額…」，前面有人錄完（`finish` 或 `dispose`）就自動開始。要開 2 路：每一路都用 `TUTORIAL_RECORD_SLOTS=2 node …` 跑（大家要設同一個值）。只有錄影佔名額，`render`／`assemble` 不佔，可以隨時跑。程序結束——包括當掉、`kill -9`——核心會自動解鎖，所以不會有「過期的鎖」要回收；鎖檔本身永遠不刪，裡面只是記誰在用。
4. **一定要 `try … finally { await chapter?.dispose(); await browser.close(); }`**。分頁被關、當掉、截圖卡住都會讓錄影中止：之後的每個動作立刻丟出原因，`dispose` 停止截圖並歸還名額，程序才能退出。
5. **等待一律不進影片**：`waitStable`、`goto`、點擊後等換頁、`offRecord` 期間的畫面都不進影片，**逾時也一樣**（只在指令列與 `events.json` 的 `quality.warnings` 留一句，寫清楚卡在哪：等不到哪個元素、哪幾個請求沒停、畫面哪一塊一直在變）。影片永遠是從「動作那一刻」直接切到「等完當下」的畫面。
   - `t.goto()` 與「點擊後**真的換頁**」會自動等新頁穩定（網路安靜、畫面內圖片與字型載完、連續兩張截圖一樣），影片從「點下去」直接切到載好的新頁，不會出現灰色未載入圖。**真的換頁**＝整頁載入，或 Next.js client-side 換到**別的路徑**（`<Link>` 點下去同步 `pushState`、或先換畫面網址晚一點才變，都算）：`t.click` 在送滑鼠事件前就開始監看，偵測到就從點擊那一刻起暫停，點擊到偵測之間截到的畫面整段丟掉；`events.json` 裡 `click` 與 `url` 的時間相同，就是影片切到新頁的那一格。
   - **只改查詢字串或 hash 不算換頁**（篩選按鈕 `?placement=…`、`replaceState`）：畫面過程照錄（例如清單重排、載入中），`t.click` 只等這一下發出的請求做完就往下走；要等它穩定再自己 `waitStable`。
   - 換頁以外的情況（打開對話框、送出後出現回執）自己呼叫：`await t.waitStable({ ready: '送出成功' })`，`ready` 可以是 Locator 或畫面上的一段字。預設最多等 30 秒；舊的 `offRecord: true` 已無作用（本來就不進影片）。
   - 換頁那一刻還在飛的請求（例如 Next.js 的 RSC prefetch）Playwright 不會再通知結束，引擎會在整頁載入後自己清掉，不會因此等到逾時；進行中超過 10 秒的請求視為不會結束的，不再等它（指令列提一次）。
6. **`offRecord` 做準備動作**：登入、補資料、切換身分、設定模擬時鐘等觀眾不需要看的事，包在 `t.offRecord(async () => { … })` 裡。期間的畫面不進影片，結束後直接切到當下畫面。密碼用 `t.type(locator, pw, { secret: true })` 或在 `offRecord` 裡打，`events.json` 不會留下原文。
7. **截圖品質**：`events.json` 的 `quality` 記整段與每一步的截圖張數／秒與最大間隔，另有 `system`（錄影開始、期間峰值、停止截圖那一刻的 loadavg 與可用記憶體，每筆帶採樣時間 `at`；之後 ffmpeg 編碼的負載不算進去——看間隔過大是不是機器太忙）。超過 50 ms 或平均低於 25 張／秒會警告並標 `ok: false`；錄影中（非暫停）兩張截圖間隔超過 100 ms 而且不是網頁自己造成的（long task、換頁、剛點擊後的更新會記在 `quality.pageJank`）就中止，訊息會寫在哪一步、哪個網址，重錄那一段即可。錄影中每 100 ms 另外抽查畫面內有沒有**還沒載好的圖片**（例如 `t.click(loc, false)` 不等穩定、或捲動後懶載入的圖）：有就記在 `quality.unloadedImages`（哪幾秒、哪張圖、哪個網址）並標 `ok: false`，在那一段加 `waitStable` 再重錄。
8. **怎麼抽格自查**：錄完先看指令列有沒有「注意」，再看幾張畫面：

   ```sh
   D=~/work/tutorial-out/runs/<run 目錄>
   jq '.quality | {ok, fps, maxGapMs, warnings, unloadedImages, system}' $D/events.json   # 品質、警告（含錄到未載入圖的時段）與系統負載
   jq -c '.events[] | select(.type=="url" or .type=="click")' $D/events.json  # 換頁與點擊的時間（ms）
   ffmpeg -v error -ss 12.5 -i $D/chapter.mp4 -frames:v 1 /tmp/check.png    # 成品第 12.5 秒（成品＝clip 時間＋2.5 秒標題卡）
   ```

   重點看：換頁後第一格圖片有沒有載好、游標與波紋是不是在按鈕上、右上角狀態標記的白話對不對、有沒有不該有的定格（等待都不該出現在影片裡）。

### `startChapter(options)`

| 選項 | 說明 |
|---|---|
| `page` | `newTutorialPage(browser)` 開的分頁（CSS 1280×587 ×1.5 ＝ 影片頁面區 1920×880；上方 80px 假網址列、下方 120px 字幕帶）。 |
| `id` | 分鏡的段編號（`3-3`、`5A-2`）；標題卡顯示「`id`｜章名第一段」。舊寫法 `number` 等同 `id`。 |
| `outDir`／`outRoot` | 見「錄影實作者須知」2：預設在 `outRoot`（`~/work/tutorial-out/runs`）下自動建新的 run 目錄。 |
| `outDir` | 這一章的輸出資料夾。 |
| `chapter`、`subtitle` | 章名與標題卡副標（預設取 `｜` 之後）。章節全名是 `3-3｜學生｜繳交作業`。 |
| `baseURL` | `t.goto('/x')` 的基準。 |
| `displayOrigin` | 假網址列顯示的主機（本機錄影時填 `test.fju.roy422.dev`）。假網址列只是顯示用：值是 UUID 的查詢參數（例如 `?cohort=<uuid>`）不會顯示（同名參數只拿掉那一組，其餘保留原本編碼）；`events.json` 的 `url` 事件仍是真實網址。 |
| `tts` | 配音 provider，預設看環境變數（`ttsFromEnv()`）：沒設是 `sayProvider({ voice: 'Meijia', rate: 190 })`；`TUTORIAL_TTS=gemini TUTORIAL_TTS_VOICE=Charon` 用 Gemini（見「換聲音重配」）。 |

### `t.step({ caption, narration, status }, fn)`

- `caption`：字幕（短）。`narration`：配音（完整句子，可以比字幕長）。
- `status`：`{ kind: 'ok' | 'warn' | 'bad' | 'pending', say?: string, evidence?: string }`，只在這一步出現在右上角。
  畫面上只顯示**圖示＋白話**（給 Roy 看的，不是依據）：
  - `ok` →「✅ 正常」，有 `say` 就「✅ 」＋say（例如「✅ 可以正常送出」）
  - `warn` →「⚠️ 」＋say（例如「⚠️ 截止提醒還沒做」；沒寫 say →「⚠️ 能用但有問題」）
  - `bad` →「❌ 」＋say（例如「❌ 按了沒反應」；沒寫 say →「❌ 還不能用」）
  - `pending` →「🟡 等你決定：」＋say（例如「🟡 等你決定：名稱要不要改」）

  `say` 超過 22 字畫面上截斷加「…」（`events.json` 留全文）。`evidence`（依據，例如「story-2 第 39 步」「UX N-17」）**不上畫面**，
  只寫進 `events.json` 與 assemble 產出的 `feature-timeline.md`（「各步驟狀態與依據」段）和 `index.html`。
  舊寫法 `status: 'ok', note: '…'` 仍可用：`note` 視為 `evidence`，不上畫面。
- **節奏由配音決定**：先合成配音（合成時間不進影片），配音在步驟開始 250 ms 後起播，`fn` 裡的動作同時進行；步驟長度至少「配音長度＋0.6 秒」，動作比配音久就照動作。
- 步驟不能巢狀。

### 動作

| 動作 | 行為 |
|---|---|
| `t.click(locator)` | 目標沒有完整在畫面裡（含被橫向／直向捲動容器切到，例如比畫面寬的表格最右邊的操作欄）就先平滑捲動（每一層容器與整頁、兩個方向都處理），捲完照新位置算游標；游標以緩動移過去（600～900 ms，速度上限 2.4 px/ms），停 150 ms 再按；放開滑鼠且頁面畫出下一格時出現橘色波紋。**真的換頁**（整頁載入、或 SPA 換到別的路徑）時，從點擊那一刻起暫停計時、等新頁穩定再繼續，波紋與載好的新頁同一格出現；只改查詢字串的不算換頁，畫面過程照錄、只等這一下的請求做完。點的是別頁的連結卻一直沒換頁，那段等待也不進影片。`t.click(loc, false)` 完全不等。 |
| `t.type(locator, text, { secret })` | 先點進欄位，再逐字輸入（每字 60～130 ms，固定種子，每次一樣）。`secret: true` 時 events.json 只記遮罩。 |
| `t.select(locator, value)` | 原生下拉：游標移過去＋波紋，直接選值（原生彈出層錄不到）。自訂下拉請用兩次 `t.click`。 |
| `t.upload(locator, file, { via })` | file input 多半隱藏，`via` 指定游標要點的按鈕。 |
| `t.press(key)` | 按一個鍵（Playwright 鍵名：`Enter`、`Escape`、`Tab`、`Control+A`、`Meta+K`…），字幕帶右邊出現小鍵帽提示（「⏎ Enter」「Esc」「⌘ K」）0.8 秒。例如在搜尋框打完字 `await t.press('Enter')`。換頁的處理跟 `t.click` 一樣：在表單裡按 Enter 送出而換頁時，從按下那一刻起暫停、等新頁穩定，載入過程不進影片（`t.press(key, false)` 不等）。 |
| `t.scroll(px \| locator \| { x, y, within })` | 平滑捲動（數字都是網頁 CSS px）。數字：整頁往下捲（負數往上）。`{ x: 400, within: locator }`：把 `within` 那個容器（例如比畫面寬的表格外層）橫向捲 400、`y` 直向；不給 `within` 就是整頁。Locator：把它的頂端對到畫面上方三分之一（本來就看得到也一樣，用來把某一區帶到畫面上方給觀眾看），它所在的每一層捲動容器也對到容器上方三分之一，橫向被切到時做最小位移。`events.json` 的 `scroll` 事件記 `dy`／`dx`（影片像素）。 |
| `t.hover(locator)`、`t.wait(ms)` | 移過去不點／停一下。 |
| `t.goto(path)` | 換頁；換頁與等穩定都不進影片（`t.goto(path, false)` 則照錄、不等）。 |
| `t.waitStable(opts)` | 見「錄影實作者須知」5；一律不進影片。 |
| `t.offRecord(fn)` | `fn` 期間的畫面不進影片，結束後直接切到當下畫面。 |
| `t.dispose()` | 收尾清理（可重複呼叫）；放在 `finally`。 |

找不到元素時 5 秒內失敗，錯誤訊息帶步驟字幕；目標怎麼捲都捲不進畫面會在指令列警告。

只對測試站操作公開頁或專用測試帳號；需要登入、送出表單的章節請用 `env/` 的本機環境。

## 後製與組裝

```sh
node engine/cli.ts render out/03-student [--out 03.mp4]            # 一章 → 1920×1080 30fps H.264＋AAC
node engine/cli.ts assemble --out out/final --features feature-table.md out/01-visitor out/03-student …
```

`render` 圖層由下到上：白底 → 錄到的頁面（夾在網址列與字幕帶之間）→ Chromium 畫的透明 PNG（假網址列＋狀態標記、底部字幕帶＋按鍵提示；開頭 2.5 秒是標題卡）→ ASS（點擊波紋、帶陰影的 macOS 樣式游標）；配音依各步起播時間混成一軌。舊的 `events.json`（沒有 `output.captionHeight`）仍照舊版面把字幕浮在頁面底部。中文用 PingFang TC（退回 Noto Sans TC），emoji 用 Apple Color Emoji。主色 `#E56E00` 取自 `web/src/app/globals.css` 的 `--primary`。

`assemble` 輸出：

- `final.mp4`：影像直接接、聲音重新編一次（避免章節交界的 AAC 空隙）；章節起點照**實際檔案長度**排。
- `youtube-description.txt`：貼到 YouTube 說明欄。開頭 `{{INTRO}}`（簡介，之後填）＋圖例（✅⚠️❌🟡 各一句）＋章節時間軸：**每段一行**，例如 `3:12 學生｜繳交作業：上傳檔案、送出、看版本、補交`，冒號後是 feature-table「功能」欄裡指到這一章的功能（依影片時間排、頓號接、超過 90 字截斷加「…」；沒有功能表就用步驟字幕）。第一行 `0:00`、時間碼遞增、不足 10 秒的段併到相鄰段，總字數 < 4500（超過會再縮短每段清單）。**不放每一步的時間碼**，否則 YouTube 不顯示章節列。少於 3 段會在指令列警告。
- `feature-table.timed.md`：feature-table 有「時間碼」欄時，另存一份填好時間碼的版本（每列取第一個對得到的時間）。
- `feature-timeline.md`：每個 F 編號一行，時間碼＋`https://youtu.be/{{VIDEO_ID}}?t=<秒>` 連結（上傳後把 `{{VIDEO_ID}}` 換掉）；影片裡沒示範的列會標出來。最後的「各步驟狀態與依據」段列每一步的狀態（圖示＋白話）與 `evidence`——依據只在這裡與 index.html，不上影片。
- `index.html`：左邊影片、右邊章節／步驟（含狀態白話與依據）與功能清單，點時間碼就跳過去。功能清單讀 `feature-table.md` 的 Markdown 表格，只認表頭含「編號」「功能」「章節與步驟」的表格（圖例之類的表格略過；可以分好幾塊、表頭要一樣），儲存格裡的直線寫 `\|`，欄數跟表頭不一樣會報錯並指出第幾行。「章節與步驟」接受 `1-1-3`（段 1-1 第 3 步）、`5A-2-2～4`（範圍）、`3-2`（先找 3-2 這段，沒有就當第 3 段第 2 步）、`4`（整段）、`第 3 章步驟 2`、用頓號分隔的多筆，括號裡的備註忽略；對不到影片的列會警告。
- `timeline.json`：每章起點與步驟時間（機器讀）。
- `final.srt`、`final.vtt`：**配音全文字幕**（上傳 YouTube 當字幕軌，不燒進畫面）。每步配音一則，起訖＝這句在整片的實際起播與結束；一則最多 2 行、每行約 18 個全形字（半形算半個），太長先在句尾（。！？；）、不夠再在逗號頓號處切成多則（沒有標點的長子句用 `Intl.Segmenter` 在詞與詞之間平均切，左括號不留在行尾、標點不在行首），時間依字數分配；章節標題卡沒有配音、不出字幕。時間取自各章 `chapter.json` 的 `steps[].narration／audio`；舊的 `chapter.json` 沒有這兩欄時，從旁邊的 `events.json` 補，都沒有的段會在指令列警告。

## 換聲音重配（不重錄）

已 render 的一段，不開瀏覽器、不重錄，換一個 TTS 把每步配音重念、接在**原本的起播時間**混成新音軌，影像直接複製（`-c:v copy`，逐格不變）：

```sh
TUTORIAL_TTS=gemini TUTORIAL_TTS_VOICE=Charon node engine/cli.ts dub ~/work/tutorial-out/chapters/3-3 [更多段…] [--out-root ~/work/tutorial-out] [--max-tempo 1.25]
node engine/cli.ts assemble --out ~/work/tutorial-out/dub-Charon/final --features feature-table.md ~/work/tutorial-out/dub-Charon/{0,1-1,…}
```

- 來源是 `chapters/<段>/`（`events.json`＋`<段>.mp4`）或 run 目錄（`events.json`＋`chapter.mp4`）。輸出到 `<out-root>/dub-<聲音>/<段>/`：`<段>.mp4`、`<段>.srt`／`.vtt`、`chapter.json`（`assemble` 可以直接吃）、`dub.json`（每步原長、新長、可用時間、加速倍率）、`audio/`。**不會寫回來源資料夾**（`chapters/<段>/` 是已上傳影片的來源）。
- Gemini：OpenRouter `google/gemini-3.8-flash-tts`，聲音由 `TUTORIAL_TTS_VOICE` 指定（候選 Charon、Orus、Algenib、Alnilam、Iapetus、Kore），模型可用 `TUTORIAL_TTS_MODEL` 換。只能拿 `pcm`（24 kHz 單聲道 s16le），引擎轉成 wav。依「模型＋聲音＋文字」雜湊快取在 `~/work/tutorial-out/tts-cache/`，**重跑不重複計費**；指令最後印「API 呼叫 N 次、快取命中 M 句」。429／5xx 退避重試（429 照 `Retry-After`），402（沒額度）直接停。
- 每句先削掉頭尾靜音（低於 −50 dB，各留 50 ms；Gemini 前後各有 0.2～0.35 秒空白），所以字幕起訖跟聽到的聲音差 50 ms 內。
- 可用時間＝到下一句起播前 0.2 秒（最後一句到 clip 結束前 0.2 秒）。比較短就照原速、後面是靜音；比較長就用 `atempo` 加速，上限 1.25 倍。**有任何一句要超過上限，這段就不輸出影片**，指令列出哪幾步、要幾倍（`dub.json` 也有），縮短配音或重錄那幾步再跑；其他段照跑，最後非 0 結束。
- `dub` 也吃 `TUTORIAL_TTS=say`（例如 `TUTORIAL_TTS_VOICE=Meijia`），可以先免費試流程。

## 錄影輸出 `events.json`

時間一律是**章節影片時間**（ms，`clip.mp4` 第 0 格＝0），座標是 clip 影片像素（不含網址列；頁面區 1920×880）。

```jsonc
{
  "id": "3-3", "chapter": "學生｜繳交作業",
  "output": { "width": 1920, "height": 1080, "chromeHeight": 80, "captionHeight": 120 },
  "page": { "width": 1280, "height": 587, "zoom": 1.5 },
  "clip": { "file": "clip.mp4", "durationMs": 55400, "fps": 30, "captureLatencyMs": 10 },
  "quality": { "ok": true, "fps": 34.1, "maxGapMs": 37, "p95GapMs": 31, "steps": [ … ], "pageJank": [], "unloadedImages": [], "warnings": [],
               "system": { "cpus": 10, "totalMemMB": 16384, "start": { "at": 1791900000000, "loadavg1": 2.1, "loadavg5": 1.8, "freeMemMB": 900 }, "peak": { "loadavg1": 3.4, "freeMemMB": 620 }, "end": { … } } },
  "steps": [{ "index": 1, "caption": "…", "narration": "…", "status": { "kind": "warn", "say": "截止提醒還沒做", "evidence": "story-2 第 39 步" },
              "startMs": 0, "endMs": 9288, "audio": { "file": "audio/step-01.wav", "startMs": 250, "durationMs": 8436 } }],
  "events": [{ "type": "move", "startMs": 300, "endMs": 1100, "from": {…}, "to": {…} },
             { "type": "click", "atMs": 1300, "x": 400, "y": 300 },
             { "type": "press", "atMs": 2100, "key": "Enter" },
             { "type": "scroll", "startMs": 2500, "endMs": 3200, "dy": 450, "dx": 600 },   // dx 只在有橫向捲動時出現
             { "type": "url", "atMs": 1600, "url": "https://…" }]   // 另有 type、select、upload
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
- `recorder.test.ts`：
  - 頁面每格畫出章節時間的二進位條碼，從 `clip.mp4` **逐格（含重複格）**解碼：每一格的影片時間與畫面內容的章節時間差：截圖達單路標準時 ≤ 50 ms，沒達標時 ≤ 實際最大間隔＋30 ms（量化誤差 ≈ 間隔 − 半格，再加負載下的延遲抖動），中位數一律 ≤ 25 ms（空機實測中位數約 8 ms、最大約 19 ms）；點擊事件與 `onclick` 讓按鈕變色的第一格同樣；點擊座標換算正確、clip 是 1920×880；步驟長度 ≥ 配音＋0.6 秒；`events.json` 有截圖品質且 `quality.ok` 與數字一致、沒有中止。**截圖張數是機器表現**（別的程序同時跑、loadavg 9～11 時會掉到 22 張／秒、間隔 70～160 ms），測試只檢查引擎有沒有正確標記，而且看畫面內容／事件時間的測試不因此中止（測試裡把中止門檻放寬到 300 ms，門檻本身另有專門測試；見 `test/env.ts`）；要用產品門檻驗機器（> 100 ms 中止、≥ 25 張／秒、≤ 50 ms、`quality.ok`）在空機上跑 `TUTORIAL_STRICT_QUALITY=1 pnpm -C tools/tutorial test`。
  - **兩路同時錄影**（兩個獨立程序、各自指定 2 個名額，跟開 `TUTORIAL_RECORD_SLOTS=2` 時一樣；`test/barcode-recording.ts`）：各自逐格誤差不超過截圖間隔（空機實測最大約 17～24 ms）、沒有中止（間隔 ≤ 100 ms）。兩路在 Mac mini 上本來就卡在單路標準邊緣（實測 24.8 張／秒、51 ms），張數不在這裡斷言。
  - 錄影中分頁被關：動作立刻報錯、名額歸還、留下 `FAILED.txt`；輸出目錄已存在就拒絕。
  - `quality.system.end` 的採樣時間早於 clip.mp4 寫完（停止截圖那一刻的快照，不含編碼負載）。
  - `waitStable`：goto 與點連結換頁到「800 ms 才回應的圖」，影片每一格都是載好的圖。
  - SPA 換頁＋慢圖（逐格）：點擊時同步 `pushState`＋換內容、以及先換內容 200 ms 後才改網址，兩種都從點擊那一格起就是載好的新頁、沒有灰圖格，`url` 與 `click` 同一時刻；伺服器版本的頁面是另一種顏色，整頁重載會露餡。
  - 真的錄到未載入圖（`click(loc, false)` 不等穩定）：`quality.ok=false`、`unloadedImages` 指出哪幾秒哪張圖。
  - 截圖空檔：網頁自己卡 250 ms 只標記；錄影程序卡 300 ms（截圖跟不上）中止並報錯。
- `waits.test.ts`：換頁回溯暫停後動作拋錯，暫停一定收尾（假分頁、不開瀏覽器）；換頁前還在飛的請求（真的 HTTP 伺服器永遠不回）不會讓之後的 `waitStable` 等到逾時；逾時原因寫實際卡住的那一項（「網路一直沒停」列出網址、「畫面一直在變」附變動範圍）；步驟裡逾時的 `waitStable`、點了別頁連結卻沒換頁的等待都不佔影片時間；`press` 記進 events.json 且鍵真的送到頁面；表單裡按 Enter 送出換到慢圖頁，從按下那一格起就是載好的新頁、press 與 url 同一時刻；同路徑只改查詢字串（`replaceState`／`pushState`）不算換頁——逐格看到「載入中」的過程、沒有回溯暫停；同網址整頁重載仍算換頁、沒有灰圖。
- `scroll.test.ts`：已經看得到的元素 `t.scroll(locator)` 仍對到上方三分之一（容器內與整頁）；比畫面寬、比容器高的表格，操作鈕在容器右下角看不到的地方：`t.click` 先把容器橫向＋直向捲過去、點擊座標等於捲完後的元素中心 × 1.5、按鈕真的被點到；`t.scroll({ x, within })`、`t.scroll(300)`、`t.scroll(locator)` 各自的位移與平滑時長。
- `runs.test.ts`：run 目錄原子建立與撞名拒絕；名額預設 1 路、第 2 路排隊印「等待錄影名額」、`TUTORIAL_RECORD_SLOTS=2` 可開第 2 路；指定 2 路時第 3 路排隊；鎖檔常駐、不自己回收。跨程序（`test/slot-holder.ts` 當獨立程序）：5 個程序同一毫秒搶 2 個名額、任何時刻持有者 ≤ 2（目錄裡留著舊鎖檔也一樣）；持有者被 `kill -9` 後名額自動釋放給排隊的。
- `render.test.ts`：狀態白話規則（「✅ 正常」「🟡 等你決定：」、say 本身超過 22 字才截斷、前綴不佔額度、evidence／note 不上畫面）、假網址列不顯示 UUID 查詢參數、按鍵鍵帽字與片段切法；合成一章實際 render，檢查格式（H.264 1920×1080 30fps＋AAC）、標題卡、網址列、底部字幕帶（深色、字幕在帶子裡）、頁面區 80～960 沒被蓋到、游標位置、波紋圓心與配音音量。
- `tts.test.ts`（假 HTTP，不打真 API）：請求格式、pcm→wav 標頭與長度、同文字同聲音走快取（重跑也是）、換聲音或模型才重打、429 照 `Retry-After` 退避再重試、502 與連線失敗重試、一直 429 到次數上限放棄、402 不重試、錯誤訊息不含金鑰、失敗不留快取檔。
- `dub.test.ts`：可用時間的算法、短→原速、長→加速到剛好放得下、超過 1.25 倍→列出；實際用 ffmpeg 重配一段（假 TTS 是前後墊 0.3 秒靜音的正弦波）：影像 framemd5 逐格相同、長度不變、來源檔沒被動、頭尾靜音削掉、字幕期間有聲／句間與標題卡靜音、`chapter.json` 的配音時間；超過上限時報錯、不出 mp4；輸出不能寫回來源。
- `subtitles.test.ts`：每則 ≤ 2 行、每行 ≤ 18 字、字一個不少、斷在標點、盡量在句尾分則、沒標點的長字串硬切、時間依字數分配且遞增不重疊、SRT／VTT 時間碼格式、整片字幕的章節位移與標題卡不出字幕。
- `assemble.test.ts`：說明欄的 YouTube 規則（第一行 0:00、時間碼遞增、間隔 ≥ 10 秒、最後一個時間碼到片尾 ≥ 10 秒、總字數上限、90 字截斷、短段合併）、功能時間軸連結、步驟狀態與依據只進 feature-timeline／index.html、功能表解析（必要表頭、`\|`、欄數不符報錯、段編號與範圍）、時間碼回填與 index.html 時間碼。

## 格式樣片

```sh
node engine/samples/visitor-sample.ts [輸出上層]   # 預設 ~/work/tutorial-out：錄在 runs/ 下的新目錄，成品複製到 sample-visitor.mp4
```

只讀 https://test.fju.roy422.dev 的公開頁（`/`、`/news`、`/projects/featured`、`/honors`），不登入、不輸入、不送出表單。
