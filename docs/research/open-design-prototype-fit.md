# Open Design 對輔大資管系專題網站原型的適配評估

- 研究日期：2026-08-17
- 評估對象：[nexu-io/open-design](https://github.com/nexu-io/open-design)
- 研究範圍：只查官方 repository、README、Quickstart、source manifests、release、privacy policy 與官方 issue
- 驗證狀態：**文件／原始碼研究完成；尚未安裝或實際執行 Open Design**

## 結論

**Verdict：把 Open Design 列為「原型輔助工具」，不要把它當作 MVP 的主要程式碼基底。**

建議用法是：

1. 先把輔大資管系網的顏色、字體、元件語言整理成一份 FJU IM `DESIGN.md`／tokens。
2. 用 Open Design 快速產生 2–3 個可比較的 Dashboard、公開首頁與工作台視覺方向。
3. 使用假資料驗證資訊架構、視覺層級、桌機／手機版與少量關鍵互動。
4. 選定方向後，在正式 `Next.js + shadcn/ui` 專案中重新實作；Open Design 產物是設計參考與可拆用的 HTML/CSS，不是直接升格為正式系統。

不建議「整個 MVP 都先用 Open Design 開發」的原因：它目前的核心輸出仍偏向**單頁 HTML artifact**；官方 Next.js 匯出外掛也自稱是 `starter downstream export plugin`、版本僅 `0.1.0`。它可以幫忙交付 App Router route/component，但沒有承諾會輸出符合本專案元件邊界、資料模型、權限、安全規則與 shadcn 組件慣例的 production code。[Web prototype contract](https://github.com/nexu-io/open-design/blob/main/design-templates/web-prototype/SKILL.md) · [Next.js export skill](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-nextjs-export/SKILL.md) · [Next.js export manifest](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-nextjs-export/open-design.json)

## 它實際是什麼

Open Design 是一套 local-first 的 Agent 設計工作台：它本身不提供固定的設計模型，而是呼叫本機的 Codex、Claude Code、Cursor、OpenCode 等 coding agent，將「brief + design template + design system」組合成 prompt，讓 Agent 寫出檔案，再於 sandboxed iframe 中即時預覽。官方描述的完整流程是：

```text
brief → plugin → direction → design system → artifact → handoff → memory
```

它可以產生 web／desktop／mobile prototype、dashboard、簡報、文件、圖片與影片；對這個專案最相關的是 prototype、dashboard、live artifact、design system，以及 HTML／ZIP／Next.js handoff。[官方 README](https://github.com/nexu-io/open-design#what-is-open-design) · [架構文件](https://github.com/nexu-io/open-design/blob/main/docs/architecture.md)

### 一般工作流

1. 選擇模板，例如 `web-prototype` 或 `dashboard`。
2. 選擇或建立 `DESIGN.md` design system。
3. 輸入產品 brief；Agent 產生 canonical project files。
4. 在 Open Design Studio 內預覽並以對話修改。
5. 匯出自包含 HTML／ZIP，或透過 handoff plugin 轉為 Next.js 等格式。

`web-prototype` 官方模板明確要求從 seed 組成一份自包含的 `index.html`，而不是一開始就生成正式 Next.js application。[web-prototype SKILL.md](https://github.com/nexu-io/open-design/blob/main/design-templates/web-prototype/SKILL.md)

## 安裝與必要環境

最快試驗路徑是下載官方 macOS desktop app；README 將它列為 zero-config 路徑，不需要先 clone repository 或安裝 Node/pnpm。它會偵測 PATH 上的 coding-agent CLI，也可改用 BYOK model endpoint。[README Quick start](https://github.com/nexu-io/open-design#quick-start) · [v0.19.2 release](https://github.com/nexu-io/open-design/releases/tag/open-design-v0.19.2)

若從原始碼執行，官方目前要求：

- Node.js `~24`
- pnpm `10.33.x`（repository pin `10.33.2`）
- `corepack enable && pnpm install`
- `pnpm tools-dev run web`

也支援 Docker Compose，預設在 `localhost:7456` 提供介面。完整要求見 [QUICKSTART.md](https://github.com/nexu-io/open-design/blob/main/QUICKSTART.md) 與 [package.json](https://github.com/nexu-io/open-design/blob/main/package.json)。

本專案第一次 trial 建議用 desktop release，不應為了試驗而 clone 並維護 Open Design monorepo。

## 能產出與不能代替的東西

### 適合產出

- 可直接在瀏覽器預覽的 HTML/CSS/JS prototype。
- 有真實文案與假資料的 Dashboard、表格、卡片、首頁版型。
- 由自訂 `DESIGN.md`、`tokens.css` 約束的視覺方向。
- 可交給 Codex 繼續拆成 Next.js route/component 的原始檔。
- 可攜的 offline HTML；官方 v0.19.2 特別改善了資產內嵌後的離線 HTML 匯出。[v0.19.2 release](https://github.com/nexu-io/open-design/releases/tag/open-design-v0.19.2)

### 不能直接代替

- Auth、RBAC、PostgreSQL schema、server actions、檔案授權與 audit log。
- 真正可維護的跨頁 App Router 架構。
- shadcn/ui component selection 與本專案 component API。
- 完整的拖拉表單資料模型、版本化、驗證與多人共用草稿。
- 成績公式、鎖定、教師平均與管理員 override 等 domain rules。
- production 測試、資安與部署驗收。

## Next.js 與 shadcn/ui 接入判斷

### Next.js：可 handoff，但不是無損轉換

官方 `od-nextjs-export` 會把**已接受的 artifact**轉成 App Router route、layout fragment 或 reusable component，要求 server-first、必要時才用 `'use client'`，並提供資產與資料需求說明。這對工程交接有用。[Next.js export skill](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-nextjs-export/SKILL.md)

但其 manifest 顯示：

- 外掛版本 `0.1.0`
- 描述為 `Starter downstream export plugin`
- styling 選項只有 Tailwind CSS、CSS Module、global CSS
- pipeline 只有一個 `handoff` stage

因此應把它視為「第一版轉譯與交接」，而不是保證可以直接 merge 的程式碼產生器。[Next.js export manifest](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-nextjs-export/open-design.json)

### shadcn/ui：可作 design-system 輸入，沒有 production-code 保證

Open Design 的 design-system import 流程支援 local folder、GitHub 與 shadcn registry；package 可包含 `DESIGN.md`、`tokens.css`、component fixture 與 Tailwind mapping。[Design Systems README](https://github.com/nexu-io/open-design/blob/main/design-systems/README.md)

這表示我們可以將 shadcn 視覺／元件契約提供給 Agent，但官方 prototype template 仍主要生成自包含 HTML，Next.js exporter 也只明確寫「prefer Tailwind」。所以：

- **可以**要求輸出風格、tokens、元件名稱盡量對齊 shadcn。
- **不能**預設產物一定會使用正確的 `Card`、`DataTable`、`Dialog`、`Form` 等專案元件。
- 正式實作時仍需由 Codex 依本 repo 的 component registry 重建與驗證。

## 四類原型適配度

| 原型 | 適配度 | 判斷 |
|---|---:|---|
| 公開首頁 | 高 | `web-prototype` 最適合快速比較 hero、公告、歷屆成果、產學合作與系網品牌方向。這是最值得先用 Open Design 的項目。 |
| 三角色 Dashboard | 中高 | 有官方 dashboard template，能快速產生 sidebar、cards、table 與 charts；但官方預設偏 KPI／analytics，必須用真實待辦、截止日、分組與簽核資料壓住「SaaS 營收儀表板」偏差。 |
| 評分工作台 | 中 | 適合比較「試算表式／逐組 rubric／左右分割」三種版面；但加權、平均、鎖定與 override 仍須另外做 domain prototype，不能以畫面漂亮代替規則正確。 |
| 拖拉表單編輯器 | 中低 | 可以 mock palette、canvas、properties panel 與拖拉動畫，但 Open Design 本身不是產品要嵌入的 form-builder library。真正的 schema、DnD、版本與發布流程仍應以 `hasanharman/form-builder` donor 或自行實作驗證。 |

官方 dashboard template 本身硬性偏好「固定 sidebar、3–4 KPI cards、chart、secondary table」，所以應將它當 starter，而非產品資訊架構答案。[Dashboard SKILL.md](https://github.com/nexu-io/open-design/blob/main/design-templates/dashboard/SKILL.md)

## 成熟度、授權與風險

### 成熟度

- Repository 建立於 2026-04-28；目前 package version 為 `0.19.2`，仍未到 1.0。[GitHub repository metadata](https://api.github.com/repos/nexu-io/open-design) · [package.json](https://github.com/nexu-io/open-design/blob/main/package.json)
- 最新 `0.19.2` 於 2026-08-14 發布，近期 release 密度很高，代表維護活躍，也代表介面與流程仍快速變動。[Releases](https://github.com/nexu-io/open-design/releases)
- README roadmap 明列 comment-mode targeted editing 仍只「partially shipped」、AI tweaks panel 尚未完成、Figma/Pencil migration plugins 為 alpha。[README Roadmap](https://github.com/nexu-io/open-design#roadmap)

所以它現在適合 time-boxed prototype spike，不適合成為 9/14 交付的關鍵 runtime dependency。

### 授權

主 repository 是 Apache-2.0；但官方明確說 bundled skills/templates 可能保留各自授權。若只把它當工具並重寫正式 UI，風險較低；若複製 template/component 到產品 repo，必須逐項保存授權與 attribution。[LICENSE](https://github.com/nexu-io/open-design/blob/main/LICENSE) · [README License](https://github.com/nexu-io/open-design#license)

### 資料與執行風險

- 它會讓 coding agent 在 managed project cwd 讀寫檔案；某些 plugin capability 包含 `fs:read`、`fs:write`、`bash`、`network` 等，因此 trial 只能對隔離的 prototype 目錄授權。[Plugin spec](https://github.com/nexu-io/open-design/blob/main/plugins/spec/SPEC.md)
- Open Design 是 local-first，但 optional product analytics 預設開啟；設定過 telemetry destination 的 build 另有不可由一般 analytics toggle 關閉的 scrubbed safety/reliability telemetry。試驗時應關閉 optional sharing，且只使用假學生／假老師資料。[PRIVACY.md](https://github.com/nexu-io/open-design/blob/main/PRIVACY.md)
- 產出品質仍取決於連接的 coding agent、brief 品質、design system 與人工審查，Open Design 本身不是設計正確性的保證。

## 建議的 60–90 分鐘 Trial Gate

### 要回答的唯一問題

> Open Design 能不能比直接用 Codex + shadcn 更快產生「Roy 願意選方向、且工程師能接手」的互動原型？

### 試驗範圍

只做兩個 artifact，不碰正式 repo：

1. **學生 Dashboard**：截止日、目前分組／指導老師、待繳交、待簽核、公告；禁止營收 KPI。
2. **管理員專題事務編輯器**：左側欄位 palette、中間 canvas、右側設定；至少可新增欄位、重排欄位、切換發布位置並看到 preview。

兩者共用一份最小 FJU IM design system：系網主色、輔色、字體、圓角、陰影、table/card 規則與禁止事項；全部只用假資料。

### 時間盒

| 時間 | 動作 |
|---|---|
| 0–10 分 | 啟動 desktop app、關閉 optional telemetry、連接既有 Codex CLI；若 10 分鐘仍無法開始生成，停止。 |
| 10–20 分 | 建立最小 `DESIGN.md`／tokens，貼入兩份具體 brief 與假資料。 |
| 20–45 分 | 產生 Dashboard 與 editor 第一版，桌機和手機預覽。 |
| 45–60 分 | 各做一次 targeted revision，例如改 sidebar 層級、把營收 KPI 換成待辦、將 editor 改成三欄。 |
| 60–75 分 | 對其中一個 accepted artifact 執行 Next.js handoff，檢查 component 邊界與 `'use client'` 使用。 |
| 75–90 分 | 依 PASS/FAIL 記錄結論；不再修工具本身。 |

### PASS 條件

必須全部成立：

1. 10 分鐘內進入可生成狀態，沒有安裝／runtime blocker。
2. 45 分鐘內得到兩個可開啟、無 broken asset 的 prototype。
3. Dashboard 沒有營收／轉換率等錯誤 SaaS 語意，且資訊層級與本規格一致。
4. Editor 至少三個關鍵互動真的可操作：新增、重排、發布位置／preview；不能只是假按鈕。
5. 一次 targeted revision 沒有破壞未要求修改的區域。
6. 1440px 與 390px 均無主要溢位、遮擋或不可讀文字。
7. Next.js handoff 能清楚拆出 route/component、client/server boundary 與 assets；估計重寫量不超過一半。
8. Roy 能在 A/B 方案中明確選出一個方向，或明確指出哪個 layout decision 被回答。

### FAIL／停止條件

符合任一項就停止，不再被工具拖垮：

- 10 分鐘仍未成功啟動或連上 agent。
- 產物只是漂亮靜態頁，關鍵 editor 互動無法執行。
- 兩輪後仍持續生成通用 SaaS dashboard，無法遵守 FJU IM design system 與真實業務文案。
- targeted revision 大幅重寫或破壞其他區域。
- Next.js handoff 是一大塊不可維護 client component，或仍須重寫超過 50%。
- trial 超過 90 分鐘仍無明確設計答案。

### Gate 後決策

- **全 PASS**：Open Design 用於後續 throwaway UI prototype；正式 MVP 仍在 Next.js + shadcn repo 重寫。
- **只有首頁／Dashboard PASS**：限制使用於視覺方向與公開頁；editor、評分與狀態機改由 Codex 直接做 HTML/React logic prototype。
- **FAIL**：不導入 Open Design；保留其 `DESIGN.md` 思路，直接用 shadcn blocks、Kiranism dashboard 與 form-builder donor 做原型。

## 最終建議

Open Design 對這個專案**有幫助，但幫助點是「更快看見與比較設計」，不是「替我們完成系統」**。最合理的順序是先讓它接受一次 60–90 分鐘 Gate；通過後用於公開首頁和角色 Dashboard，再視表單編輯器與評分工作台的互動品質決定是否擴大。不要在 trial 前把它寫進正式架構，也不要讓它產生的 HTML 直接變成 production source of truth。

## 2026-08-17 實測結果

這次試驗得到的是**部分通過，不是 Open Design 全面 PASS**：

- 安裝與安全檢查：Open Design Desktop `0.19.2` 安裝完成，macOS Gatekeeper 判定為 Notarized Developer ID；optional metrics、content sharing、artifact manifest sharing 均已關閉。
- Project／conversation 建立：公開前台、學生 Dashboard、管理編輯器三個 Open Design project 均建立成功。
- 內建 Agent runtime：三個 Open Design → Codex run 都在第一個 token 前遭 `SIGKILL`，分類為 `process_exit / signal_killed`，各自產出 0 artifact。依停止條件不修改憑證、不切換其他模型，也不無限重試；此項判定 **FAIL**。
- 補救產出：以三個隔離的 OpenAI Codex 工作 Session，沿用相同 brief 與 FJU IM design contract，各自完成自包含 HTML；每個 artifact 都包含 A／B／C 三種結構方向。
- 獨立瀏覽器驗收：9 個桌機 variant 加 3 個 390 px 鍵盤切換測試共 12／12 PASS；另外三條核心互動流程 3／3 PASS。驗收曾抓到學生 Dashboard 的 `data-variant` 事件代理誤攔所有 click，修正為只匹配切換按鈕後重新驗收通過。最終沒有 runtime／console error、外部請求或頁面級橫向溢位。
- Open Design 作為容器：三個驗收後 artifact 已匯回原本的 Open Design projects，manifest 狀態為 `complete`，三個 preview route 均回 HTTP 200；再以 headless Chrome 直接從 preview route 驗證 C→B 切版與代表性 click 互動，3／3 PASS 且無 runtime／console error。此項 **PASS**。
- 尚未驗收：Roy 的方向選擇與選定方向的 Next.js handoff，仍為 **PENDING**。

因此本機現況應採用：**OpenAI Codex 負責生成與修訂，Open Design 暫時只負責 project／artifact 預覽與比較**。在 Open Design 的 Codex runner 問題另案修復前，不讓它成為原型或 9/14 交付的關鍵路徑。

## 官方來源索引

- [Open Design repository／README](https://github.com/nexu-io/open-design)
- [Quickstart](https://github.com/nexu-io/open-design/blob/main/QUICKSTART.md)
- [Architecture](https://github.com/nexu-io/open-design/blob/main/docs/architecture.md)
- [Package manifest](https://github.com/nexu-io/open-design/blob/main/package.json)
- [Latest release v0.19.2](https://github.com/nexu-io/open-design/releases/tag/open-design-v0.19.2)
- [Web prototype template](https://github.com/nexu-io/open-design/blob/main/design-templates/web-prototype/SKILL.md)
- [Dashboard template](https://github.com/nexu-io/open-design/blob/main/design-templates/dashboard/SKILL.md)
- [Design-system package contract](https://github.com/nexu-io/open-design/blob/main/design-systems/README.md)
- [Next.js export skill](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-nextjs-export/SKILL.md)
- [Next.js export manifest](https://github.com/nexu-io/open-design/blob/main/plugins/_official/scenarios/od-nextjs-export/open-design.json)
- [Plugin specification](https://github.com/nexu-io/open-design/blob/main/plugins/spec/SPEC.md)
- [Privacy policy](https://github.com/nexu-io/open-design/blob/main/PRIVACY.md)
- [Apache-2.0 license](https://github.com/nexu-io/open-design/blob/main/LICENSE)
