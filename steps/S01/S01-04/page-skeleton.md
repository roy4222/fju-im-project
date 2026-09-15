# S01-04 證據：頁面骨架、側欄導覽與授權導向

票：[#47](https://github.com/roy4222/fju-im-project/issues/47)｜執行時間：2026-09-15 21:10 CST
｜Next 16.3.3｜Tailwind 4.3.3

## 1. 路由

`pnpm -C web build` 的路由表（全部動態渲染，因為 CSP 用 nonce）：

```
┌ ƒ /                          首頁空殼
├ ƒ /403                       統一的沒有權限頁（帶「回到自己的首頁」）
├ ƒ /account                   本人帳號頁殼
├ ƒ /account/change-password   強制改密頁殼（表單由 S01-05）
├ ƒ /api/auth/[...all]         （S01-02）
├ ƒ /api/health                （S00-08）
├ ƒ /dashboard/admin           系辦首頁殼
├ ƒ /dashboard/admin/accounts  帳號（側欄掛載點一）
├ ƒ /dashboard/admin/cohorts   屆別（側欄掛載點二）
├ ƒ /dashboard/student         學生首頁殼
├ ƒ /dashboard/teacher         老師首頁殼
├ ƒ /login                     登入頁殼（表單由 S01-05）
├ ƒ /register                  註冊頁殼（表單由 S01-09）
└ ƒ /register/pending          等待審核頁殼
```

## 2. 票第 3 節那張表，逐列的實際結果

| 操作 | 預期 | 實際 |
|---|---|---|
| 不登入開 `/`、`/login`、`/register`、`/register/pending` | 四頁都開得起來，各有空狀態或空表單殼 | ✅ 四頁都 200（另加 `/403` 也 200） |
| 不登入直接開 `/dashboard/admin` | 被導到登入頁 | ✅ 307 → `/login?next=%2Fdashboard%2Fadmin` |
| 以 A1 身分開 `/dashboard/admin` | 管理員首頁殼與側欄，側欄有「帳號」「屆別」 | ✅ 見 `admin--home.png`；點進去都是空狀態 |
| 以 S01 身分開 `/dashboard/admin/accounts` | 403 頁，並有「回到自己的首頁」 | ✅ 307 → `/403`，下一步指向 `/dashboard/student`（見 `student--403.png`） |
| 以 T1 身分開 `/dashboard/teacher` 與 `/account` | 兩頁都開得起來 | ✅ 都 200 |
| 用手機寬度開學生首頁殼 | 側欄收合、內容單欄、沒有橫向捲動 | ✅ 見 `student--home-mobile.png`；`scrollWidth ≤ clientWidth` |

另外補了兩條票面沒列但該有的：

- **待審核的人**（有 session、還沒核准）開後台 → 導到 `/register/pending`，**不是** 403。
  他不是沒權限，是還沒輪到他。
- 後台的**子頁**（不只首頁）沒登入一樣被導走。

## 3. 抓到一個真的安全漏洞（本票最重要的一段）

第一版的寫法是「角色檢查放在 layout，不合格就改渲染 403 畫面」。畫面完全正確。
但 e2e 的「學生 cookie 直接 GET 管理頁」那條把回應 body 抓下來一看：

```
Expected substring: not "名單匯入、註冊審核、停用與臨時密碼"
Received string: "<!DOCTYPE html>… <h1>帳號</h1><p>名單匯入、註冊審核、停用與臨時密碼都在這一區。</p>
                  …還沒有帳號資料。名單匯入（S01-10）與註冊審核（S01-11）接上之後會出現在這裡。…"
```

**管理頁的完整內容出現在回應裡**——畫面上看不到（layout 沒有把它放進去），但 view-source
看得到。原因是 App Router 把 layout 與底下的 page **並行渲染**：layout 拿到的 `children`
是一棵已經算好的樹，丟掉它不代表那一頁沒被做出來。

第二版改成 layout `redirect('/403')`。仍然漏：

```
4:E{"digest":"NEXT_REDIRECT;replace;/403;307;"}
…同一份 payload 裡還是有 "名單匯入、註冊審核、停用與臨時密碼"…
```

`redirect()` 是用丟例外實作的，但那一頁的內容已經串進去了，Next 回的是一份
`__next_error__` 文件，內容照樣在裡面。

**修法**：角色檢查移到**每一頁自己**（`await requireRole(path, role)` 放在頁面元件的第一行）。
頁面自己 redirect，內容就根本不會被產生出來。

```
$ curl -s -o /tmp/x.html -w 'HTTP %{http_code}\n' http://127.0.0.1:3000/dashboard/admin/accounts
HTTP 307
$ grep -c "名單匯入、註冊審核" /tmp/x.html
0
```

layout 留著做「要登入」那一道（那一道本來就只是導向，沒有內容外洩的問題）。

### 回歸測試

`e2e/pages.spec.ts` 的最後一組**逐條走每一個受保護路由**，用「沒有 cookie」與
「角色不對的 cookie」兩種身分，斷言回應裡沒有那一頁的任何一段字：

```
✓ /dashboard/admin：沒有 cookie 拿不到任何內容
✓ /dashboard/admin：角色不對（student）拿不到任何內容
✓ /dashboard/admin/accounts：沒有 cookie 拿不到任何內容
✓ /dashboard/admin/accounts：角色不對（student）拿不到任何內容
✓ /dashboard/admin/cohorts：沒有 cookie 拿不到任何內容
✓ /dashboard/admin/cohorts：角色不對（teacher）拿不到任何內容
✓ /dashboard/teacher：沒有 cookie 拿不到任何內容
✓ /dashboard/teacher：角色不對（student）拿不到任何內容
✓ /dashboard/student：沒有 cookie 拿不到任何內容
✓ /dashboard/student：角色不對（teacher）拿不到任何內容
```

清單來源是 `src/app/dashboard/_nav.ts` 的 `PROTECTED_ROUTES`；新增後台頁面時兩邊一起補，
忘了加守衛這裡就會紅。

> **提醒下一張票**：這條規則對 S01-11 之後那些「頁面上真的有資料」的票更重要——
> 授權檢查一定要在頁面（或用例）裡，不能只靠 layout。

## 4. 畫面

| 檔案 | 內容 |
|---|---|
| `guest--home.png` | 首頁空殼 |
| `guest--login.png` | 登入頁殼（明寫「登入表單還沒做」） |
| `admin--home.png` | 系辦首頁：側欄有「帳號」「屆別」，三塊磚的數字是 `—` |
| `admin--accounts-empty.png` | 帳號頁：表格欄位定了，**內容是空狀態**，不是假資料 |
| `student--403.png` | 學生開管理頁被帶到 `/403`，有「回到自己的首頁」 |
| `student--home-mobile.png` | 390px 寬：側欄收成「選單」，單欄，無橫向捲動 |

## 5. 視覺：收斂成系網橘單一主軸

原型的 token 是「深藍 primary ＋ 橘 brand」兩個主色。票 #47 與 Roy 的偏好都寫
**「配色是系網橘單一主軸」**，所以這裡改成：

| token | 值 | 用在哪 |
|---|---|---|
| `--color-primary` | 系網橘 `#E56E00` | **唯一的強調色**：主要按鈕、側欄選中項、標籤 |
| `--color-ink` | 系網深藍 `#003366` | 降為深中性：標題文字、側欄底 |
| `--color-primary-subtle` / `-on-subtle` | 橘的淺底與淺底上的字 | 「這個功能還沒做」標籤 |

沒有第二個主色。請 review 確認這個收斂符合預期——若要保留原型的深藍當主色，改
`src/app/globals.css` 的 `@theme` 兩個變數即可，元件不用動。

## 6. 依賴與元件的取捨

新增四個套件：`tailwindcss` 4.3.3、`@tailwindcss/postcss` 4.3.3（devDeps）、
`clsx` 2.1.1、`tailwind-merge` 3.6.0。

**沒有**把原型的 shadcn／base-ui／Radix 搬過來。本票只需要按鈕、表格、對話框殼、磚四種
基底，全部用 Tailwind 類別自己寫（`src/app/_ui/primitives.tsx`），對話框用原生 `<dialog>`
（它自己就有 modal、Esc 關閉與焦點鎖）。理由：

- 這一批不需要互動元件；等真的需要下拉、彈出定位時再引入，那時也才知道需要哪些。
- `audit` 那道門檻只看會進到 `web/` 的相依路徑，依賴越少越不容易被卡。
- 側欄的行動版收合用 `<details>`，**不需要任何 client JS**，也就不必為了一個選單放寬 CSP。

CSP 沒有改：Tailwind 產出的是 `self` 的外部樣式表，`style-src 'self' 'nonce-…'` 本來就允許。

## 7. 本機跑出來的結果

```
$ pnpm -C web typecheck                 ✅
$ pnpm -C web lint                      ✅
$ pnpm -C web lint:boundaries-test      ✅ 14 反例 7 合法例
$ pnpm -C web build                     ✅ 15 條路由
$ pnpm -C web test:unit                 ✅ 9 檔 141 條
$ pnpm -C web vitest run --project integration src/
                                        ✅ 8 檔 310 條
$ pnpm -C web test:e2e                  ✅ 33 條（S00 的 6 條 ＋ 本票 27 條）
$ pnpm audit + audit-check --level high ✅ 沒有影響 web/ 的 high／critical
```

## 8. 本機跑 e2e 的兩個坑（不是程式問題，但會浪費時間）

1. **Better Auth 內建限速**：預設 10 次／60 秒／IP，涵蓋整個 `/api/auth/*`。
   e2e 造測試帳號會用到，連續重跑本機會撞 429。`e2e/session.ts` 每個角色只註冊一次，
   撞到就等一個視窗再試一次（**沒有把限速關掉**）。
   > 順帶一提：這個預設值對正式環境太緊——全系在同一個對外 IP 後面，一分鐘只有 10 次就會擋到
   > 正常登入。契約 03 §6 的逐路由限速由 **S01-05／S01-15** 實作，屆時要一併調整這個預設。
2. **整合測試會改掉 `fju_app` 的密碼**：`test/db.ts` 的 `poolAsRole` 用 `ALTER ROLE` 設一個
   測試密碼（S00-03 就是這樣寫的）。本機用同一個資料庫跑整合測試與起站時，跑完整合測試要
   重設密碼站才連得上。CI 不受影響（兩個 job 各自有自己的 postgres）。

## 9. NOT_RUN／沒做什麼

- CI 七道在本 PR 的最新 commit：**待 PR 開出後回填**。
- **任何表單與功能都沒有**：登入表單 S01-05、註冊表單 S01-09、各對話框各功能票、
  首頁階段文字 S02-05、通知匣入口 S02-08。每一個空狀態都寫明「這個功能還沒做」與由哪張票接，
  **沒有用假資料冒充已完成**。
- 公開頁（最新消息、歷屆專題、競賽、產學）：後面的切片，首頁只放一個空狀態說明。
- 深色模式：本票不做（`color-scheme: light`）。
- VM 部署：**NOT_RUN**（#187–#189）。
