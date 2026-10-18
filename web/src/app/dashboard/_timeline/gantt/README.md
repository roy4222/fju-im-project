# 專題時程甘特（C3-03）

系辦時程頁（`mode='edit'`，C3-08 掛）與前台 `/timeline`（`mode='view'`，C3-14 掛）共用的甘特。規格：規格③《設計方案》§9.3。

| 檔案 | 內容 |
|---|---|
| `gantt-model.ts` | 凍結介面（`GanttProps` 等）與純函式：日期↔像素、階段最後一天、夾限、車道、縮放刻度、鍵盤位移、畫面句子。單元測試 `gantt-model.test.ts` |
| `gantt.tsx` | client 元件（`'use client'`）。只管畫與事件，寫入全部走 `editor` |
| `gantt.css` | 一般 stylesheet。位置寬度都是 CSS 變數（`--x`、`--w`、`--lane`…），由元件用 CSSOM 寫 |
| `gantt-dialogs.tsx` | 活動視窗殼（`renderForm` 注入表單）、刪除確認、階段確認、右鍵選單。gantt 只在 edit 模式動態載入 |

## 怎麼掛

```tsx
const Gantt = dynamic(() => import('../_timeline/gantt/gantt'), { ssr: false, loading: () => <div className="dash-card h-80" /> })
<Gantt cohortId={…} stages={…} yearEndDate={…} activities={…} deadlines={…} today={…} mode="edit" editor={…} />
```

一定要 `ssr: false`：位置靠瀏覽器端 CSSOM 設定，SSR 不能輸出 `style=`（CSP）。

## 介面（凍結，C3-08、C3-13 不另加方法）

- `stages`：`{ seq, name, startDate, lastDate, deadlineVersion }`；`yearEndDate` 可為 null（沒有年度結束日的把手）。
- `activities`：`{ id, title, startDate, endDate, allDay, startTime, endTime, timeText, audienceKind, status, revision }`；`status='cancelled'` 不畫。
- `deadlines`：`{ id, title, date, href }`，鎖住；有 `href` 是連結。
- `editor`（只有 edit 模式）：
  - `saveSchedule(input)`：階段分界／年度結束日放開，或把手上按 Enter。確認框由 adapter（`gantt-mount`）做；resolve `{ ok:true }` 停在新位置、`{ ok:false, cancelled:true }` 只回彈、其他失敗回彈＋`role="alert"`。`input.revision` 用 `editor.cohortRevision`。
  - `moveActivity(id, revision, startDate, endDate)`：活動拖拉或鍵盤，放開就存（不確認）。成功 status「已把「說明會」改到 3/8」；失敗回彈＋伺服器句子。
  - `openEdit(id, prefill?)`：一般點擊、Enter、選單「編輯」不傳 prefill；非全天且 `endTime` 為 null 的活動被拉成跨日時**不送 `moveActivity`**，回彈並傳拖後起訖（AC-C3-48）。
  - `openCreate({ startDate, endDate })`：點某列空白處，起訖都是點到的那天。
  - `openStage(seq)`：點階段色塊（或聚焦按 Enter）。
  - `remove(id, revision)`：gantt 自己先跳刪除確認，按「刪除」才呼叫；成功 status「已刪除活動「X」」。
- 樂觀位置：存成功後停在新位置，等伺服器資料換新（活動 `revision` 變了、階段日期變了）就改用伺服器資料。

## `data-testid`

| testid | 元素 | 備註 |
|---|---|---|
| `gantt` | 外框 | `data-mode="edit|view"` |
| `gantt-stage` | 階段色塊 | edit 是 `button`、view 是 `span`；`data-seq`；`aria-label` 含名稱與日期 |
| `gantt-handle` | 把手 | `data-kind`：`stage`（`data-seq`＝右邊那段）、`year-end`、`activity-start`、`activity-end`（橫條兩端，`aria-hidden`）。view 與手機都沒有 |
| `gantt-bar` | 活動橫條 | edit 是 `button`（`data-id`）、view 是 `<a href="#activity-<id>">`；`aria-label`「名稱，3/10–3/12 時間」 |
| `gantt-deadline` | 作業截止菱形 | 有 `href` 是 `<a>`；`title`／`aria-label`「作業截止：名稱，12/1」 |
| `gantt-today` | 今天線 | `aria-label`「今天 3/3」 |
| `gantt-menu` | 右鍵選單 | `role="menu"`，項目 `menuitem`「編輯」「刪除」 |
| `gantt-zoom` | 縮放鈕組 | 「週」「月」，`aria-pressed` |

## 互動對照表（edit 模式）

| 操作 | 滑鼠 | 鍵盤（橫條或把手聚焦） | 結果 |
|---|---|---|---|
| 平移活動 | 拖橫條中間 | `←→` 一天、`Shift+←→` 一週 | 放開（鍵）就 `moveActivity` |
| 改結束日 | 拉右端 | `Alt+←→` | 同上 |
| 改開始日 | 拉左端 | `Alt+Shift+←→` | 同上 |
| 編輯活動 | 點橫條 | `Enter` | `openEdit(id)` |
| 刪除活動 | 選單「刪除」 | `Delete` | 確認框 →`remove` |
| 選單 | 右鍵、長按 600ms | `Shift+F10`、`ContextMenu` | Esc／Tab／點外面關，焦點回橫條 |
| 新增活動 | 點某列空白處 | （頁面的「新增活動」鈕） | `openCreate` |
| 編輯階段 | 點色塊 | `Enter` | `openStage(seq)` |
| 階段分界／年度結束日 | 拖把手放開 | `←→`／`Shift+←→` 調、`Enter` 送、`Esc` 或離開放棄 | `saveSchedule`；夾限：嚴格遞增、年度結束日不早於最後一段開始日 |
| 縮放 | 「週」「月」、`Ctrl+滾輪` 微調 | — | 存 `localStorage`（`gantt-zoom`） |

- 拖拉中橫條（把手）旁顯示即時日期；螢幕報讀用 `aria-live="polite"`，停下 400ms 才讀一次。
- 手機或觸控（`(pointer: coarse), (max-width: 767px)`）：沒有把手、不能拖，點一下編輯、長按開選單；橫條 `aria-disabled="true"`（AC-C3-40）。Playwright 的 `click()` 會把 `aria-disabled` 當成不可點，手機測試用 `dispatchEvent('click')` 或 `click({ force: true })`。
- 觸控區：可點的列 `min-h-11`、縮放鈕 `pointer-coarse:size-11`（④ X-④-4）。
- view 模式：沒有把手、沒有選單；仍可縮放與鍵盤捲動（捲動區 `tabIndex=0`）。
