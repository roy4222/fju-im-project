# 輔大資管系專題管理平台 — 元件庫使用慣例

這套元件庫是輔仁大學資訊管理學系專題管理平台的實際生產程式碼：Next.js 16 + React 19 +
Tailwind CSS v4 + shadcn/ui（`style: base-nova`，primitives 為 **Base UI**，非 Radix）。
介面語言是繁體中文，使用情境是**大學系所的官方網站與行政後台**——公告、專題規則、
產學合作、分組、文件繳交、評分與線上簽核。語氣是公告，不是行銷。

## 1. 包裝與設定

元件從 `window.FjuIm` 匯入。有兩個 provider 必須包在外層，否則對應元件會直接拋錯或渲染空白：

```jsx
// 用到任何 Tooltip 時
<TooltipProvider>{children}</TooltipProvider>

// 用到 Sidebar 家族時（SidebarInset 必須是 SidebarProvider 的子層）
<SidebarProvider>
  <Sidebar collapsible="icon">…</Sidebar>
  <SidebarInset>…</SidebarInset>
</SidebarProvider>
```

深色主題是 **class-based**：在根元素加上 `dark` class 即切換，所有語意 token 會自動換值。
不要自己寫深色的顏色值，也不要用 `dark:` 加上原始色（例如 `dark:bg-gray-900`）——
語意 token 本身已經處理好兩種主題。

**Base UI 不是 Radix**：沒有 `asChild`。要把元件渲染成別的標籤或元件，用 `render` prop：

```jsx
<SidebarMenuButton render={<a href="/dashboard">首頁</a>} />
<DropdownMenuTrigger render={<Button variant="outline">切換角色</Button>} />
```

`Checkbox` 的不確定狀態是獨立的 `indeterminate` prop，不是 `checked="indeterminate"`。

`Progress` 的 Root 會在 children 之後**自動渲染一組 Track 與 Indicator**。children 只放
`ProgressLabel` 與 `ProgressValue`；再手動加 `ProgressTrack` 會變成上下兩條線。

## 2. 樣式寫法：語意 token，不用原始色

版面與間距用一般的 Tailwind utility。**顏色一律只用下列語意 class**，
不要用 `bg-blue-600`、`text-gray-500` 這類原始色階——它們不會跟著品牌與深色主題走。

編譯進這份 CSS 的語意色 class 就是下面這 50 個，**清單以外的組合沒有對應規則、會沒有樣式**：

| 用途 | 可用 class |
|---|---|
| 底與文字 | `bg-background` `text-foreground` `bg-card` `text-card-foreground` `bg-popover` `text-popover-foreground` |
| 主色（系網深藍 #003366） | `bg-primary` `text-primary` `text-primary-foreground` `border-primary` |
| 次要（系網暖白 #FFF4EA） | `bg-secondary` `text-secondary-foreground` |
| 品牌強調（系網橘 #E56E00） | `bg-brand` `text-brand` `text-brand-foreground` `bg-brand-subtle` `text-brand-on-subtle` `border-brand` |
| 弱化 | `bg-muted` `text-muted-foreground` |
| 成功 | `bg-success` `text-success` `bg-success-subtle` `text-success-on-subtle` `border-success` |
| 警告 | `text-warning` `bg-warning-subtle` `text-warning-on-subtle` `border-warning` |
| 資訊 | `text-info` `bg-info-subtle` `text-info-on-subtle` `border-info` |
| 危險 | `bg-destructive` `text-destructive` `bg-destructive-subtle` `text-destructive-on-subtle` `border-destructive` |
| 框線與輸入 | `border-border` `border-input` `bg-border` |
| 側欄 | `bg-sidebar` `text-sidebar-foreground` `bg-sidebar-border` `border-sidebar-border` `ring-sidebar-ring` |

**`-subtle` 與 `-on-subtle` 一定成對使用**：`-subtle` 是淺色底，`-on-subtle` 是配在那個底上的
文字色。把 `-foreground`（實色底上的文字）用在 `-subtle` 底上會造成對比不足。

```jsx
// 正確：淺底配 on-subtle 文字
<Badge variant="outline" className="border-brand/30 bg-brand-subtle text-brand-on-subtle">產學合作</Badge>
// 錯誤：對比只有 2.8:1
<Badge className="bg-brand-subtle text-brand-foreground">產學合作</Badge>
```

**品牌橘不是 hover 底色。** hover 與選取狀態用 `bg-accent`；橘色保留給分類標籤、
截止倒數與需要吸引注意的單一動作。

## 3. 字體與字級

三層字體，透過 CSS 變數指定，不要直接寫字體名稱：

- `--font-sans`（預設）：Geist + Noto Sans TC — 內文、UI、表格
- `--font-display`：Noto Serif TC（思源宋體）— 中文標題
- `--font-brand`：Kaisei Tokumin — wordmark 與數字。**這是日文字集，繁中缺
  產／歷／檔／繳／查／內／辦／錄 等字，只用在拉丁字母與數字，不要用於中文長文。**

已編譯的字級工具類（tracking 與 leading 都已依字級調校，直接用，不要自己疊
`text-4xl tracking-tight`）：

| class | 用途 |
|---|---|
| `.type-display` | 首頁焦點區大標 |
| `.type-section` | 區塊標題、頁面標題 |
| `.type-card-title` | 卡片標題 |
| `.type-eyebrow` | 小型大寫拉丁標籤 |
| `.type-brand` | 站名 wordmark |
| `.tabular` | 數字、學號、日期（等寬數字，避免欄位跳動） |

其他兩個行為類：`.press`（按下時輕微縮放，已處理 `prefers-reduced-motion`）、
`.scroll-edge`（捲動邊緣遮罩，取代 sticky 元素下方的 1px 分隔線）。

## 4. 真相在哪裡

- **`styles.css` 與它 `@import` 的 `_ds_bundle.css`** — 所有 token 的實際值與可用的 utility。
  要確認某個 class 存不存在，直接讀這個檔案。
- **`components/<group>/<Name>/<Name>.d.ts`** — 該元件的 props 契約。
- **`components/<group>/<Name>/<Name>.prompt.md`** — 該元件的用法說明與範例。

## 5. 版面慣例

這是機關網站，不是行銷網站。既有頁面遵守這些規則：

- **標題用名詞**（「最新公告」「近期截止」），不用行銷標語（不寫「專題，不只是一學年的作業」）。
- **一屏一件事**：區塊垂直間距 `py-16 md:py-24`，每個區塊一個標題、最多三張卡、一個「查看更多」。
- **不用裝飾性漸層、光暈或同心圓**；漸層只在有功能理由時使用（例如表格水平捲動的邊緣提示）。
- **icon 一律用 `@tabler/icons-react`**，不用 emoji。
- **列表要有五種狀態**且彼此不同：空白、載入、錯誤、無權限、查無結果。
- 大型名單用 `Table` 搭配固定欄寬與 `truncate`，不要讓長內容撐高整列。

## 6. 一個典型組合

```jsx
<section className="py-16 md:py-24">
  <div className="mx-auto max-w-6xl px-5">
    <div className="mb-8 text-center">
      <span aria-hidden className="mx-auto block h-0.5 w-10 rounded-full bg-brand" />
      <h2 className="type-section mt-4">近期截止</h2>
      <p className="mt-2.5 text-[0.9375rem] text-muted-foreground">
        登入後可看到自己組別的繳交狀態與待辦。
      </p>
    </div>

    <ul className="mx-auto max-w-3xl divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      <li className="flex items-center gap-4 px-5 py-4">
        <div className="w-16 shrink-0 text-center">
          <p className="tabular text-2xl font-semibold leading-none">26</p>
          <p className="tabular mt-1 text-xs text-muted-foreground">08 月</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">指導老師意願調查表</p>
          <p className="mt-0.5 text-xs text-muted-foreground">對象：114 學年度學生</p>
        </div>
        <Badge variant="outline" className="border-brand/30 bg-brand-subtle text-brand-on-subtle">
          剩 9 天
        </Badge>
      </li>
    </ul>
  </div>
</section>
```
