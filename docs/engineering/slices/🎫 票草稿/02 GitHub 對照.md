---
type: ticket-map
project: FJU IM Project
updated: 2026-09-13
status: published
---
# GitHub 實作 backlog 對照（2026-09-13 發布）

> 發布 commit `ef62bc3`（票內固定來源連結釘於此）。15 個 epic #18–#32、166 張實作票 #33–#198。狀態：ready 1、planned 122、blocked-decision 10、blocked-dependency 33。**發布不等於開工授權**：S00 開工前仍須 Roy 確認 GitHub 方案、T3、T2（前置清單 §7、§2.1）；受阻票保留標記直到對應決策或前置 epic 出場。spec review issue #6、#8–#17 已更新為現行版本並加 epic 入口。

## epic

| epic | 切片 | issue | 票數 | 直接受阻 | 間接受阻 |
|---|---|---|---|---|---|
| E00 | S00 工程骨架、分層 lint、Compose、CI、第一支 migration | [#18](https://github.com/roy4222/fju-im-project/issues/18) | 11 | 0 | 0 |
| E01 | S01 帳號與 Auth、最小屆別與開放註冊、名單、核准、稽核與帳本 | [#19](https://github.com/roy4222/fju-im-project/issues/19) | 16 | 0 | 0 |
| E02 | S02 屆別、階段、業務鐘、事件表與 worker、通知匣 | [#20](https://github.com/roy4222/fju-im-project/issues/20) | 9 | 0 | 0 |
| E03 | S03 提案與成組 | [#21](https://github.com/roy4222/fju-im-project/issues/21) | 9 | 0 | 0 |
| E04 | S04 專題事務發布、收件名單表、公開內容頁 | [#22](https://github.com/roy4222/fju-im-project/issues/22) | 9 | 0 | 0 |
| E05 | S05 個人收件 | [#23](https://github.com/roy4222/fju-im-project/issues/23) | 8 | 0 | 0 |
| E06 | S06 指導與產學 | [#24](https://github.com/roy4222/fju-im-project/issues/24) | 11 | 0 | 0 |
| E07 | S07 組別繳交主線 | [#25](https://github.com/roy4222/fju-im-project/issues/25) | 9 | 0 | 0 |
| E08 | S08 名單變動與到期工作 | [#26](https://github.com/roy4222/fju-im-project/issues/26) | 17 | 2 | 0 |
| E09 | S09 成員異動與解散 | [#27](https://github.com/roy4222/fju-im-project/issues/27) | 4 | 1 | 3 |
| E10 | S10 評分 | [#28](https://github.com/roy4222/fju-im-project/issues/28) | 13 | 0 | 0 |
| E11 | S11 簽核（含最小精選草稿建表） | [#29](https://github.com/roy4222/fju-im-project/issues/29) | 13 | 2 | 0 |
| E12 | S12 公開精選、授權與收尾 | [#30](https://github.com/roy4222/fju-im-project/issues/30) | 16 | 0 | 16 |
| E13 | S13 封存、多屆與下一屆 | [#31](https://github.com/roy4222/fju-im-project/issues/31) | 9 | 3 | 6 |
| E14 | S14 維運執行 | [#32](https://github.com/roy4222/fju-im-project/issues/32) | 12 | 2 | 8 |

## 實作票

| 票號 | issue | 狀態 | 標題 |
|---|---|---|---|
| S00-01 | [#33](https://github.com/roy4222/fju-im-project/issues/33) | ready | [S00-01][工程基礎] 建立 web/ 專案骨架、六層目錄與共用的時鐘、結果、錯誤碼工具 |
| S00-02 | [#34](https://github.com/roy4222/fju-im-project/issues/34) | planned | [S00-02][工程基礎] 釘死 Better Auth 與 drizzle 版本，產出帳號四表的 schema 並核對欄名 |
| S00-03 | [#35](https://github.com/roy4222/fju-im-project/issues/35) | planned | [S00-03][工程基礎] 讓 pnpm test 能對真的 PostgreSQL 跑整合測試 |
| S00-04 | [#36](https://github.com/roy4222/fju-im-project/issues/36) | planned | [S00-04][工程基礎] 跑第一支 migration，把帳號四表、屆別與五張基礎表建進空資料庫 |
| S00-05 | [#37](https://github.com/roy4222/fju-im-project/issues/37) | planned | [S00-05][工程基礎] 建三個資料庫角色、依權限矩陣產生 GRANT、鎖住不可變表，並逐表測試 |
| S00-06 | [#38](https://github.com/roy4222/fju-im-project/issues/38) | planned | [S00-06][工程基礎] 用 lint 擋住跨層亂引用，並以七個反例與三個合法例證明規則有效 |
| S00-07 | [#39](https://github.com/roy4222/fju-im-project/issues/39) | planned | [S00-07][工程基礎] 用 Docker Compose 定義六個服務、Caddy 設定與 .env.example |
| S00-08 | [#40](https://github.com/roy4222/fju-im-project/issues/40) | planned | [S00-08][工程基礎] 做 /api/health 健康檢查端點與空殼首頁 |
| S00-09 | [#41](https://github.com/roy4222/fju-im-project/issues/41) | planned | [S00-09][工程基礎] 接上 CI 七道檢查，讓每個 PR 都自動跑型別、lint、測試、build、smoke 與套件稽核 |
| S00-10 | [#42](https://github.com/roy4222/fju-im-project/issues/42) | planned | [S00-10][維運] 準備只能手動觸發且預設演練的部署流程（cd.yml 與 deploy.sh --dry-run） |
| S00-11 | [#43](https://github.com/roy4222/fju-im-project/issues/43) | planned | [S00-11][工程基礎] 全站加上 CSP 與安全標頭，擋掉未授權的注入腳本 |
| S01-01 | [#44](https://github.com/roy4222/fju-im-project/issues/44) | planned | [S01-01][模組01 帳號與權限] 第二支 migration：在 S00 之上新增帳號模組九表與檔案兩表 |
| S01-02 | [#45](https://github.com/roy4222/fju-im-project/issues/45) | planned | [S01-02][模組01 帳號與權限] 把 Better Auth 掛上網站，封鎖不該對外的路由，新帳號一律先進待審 |
| S01-03 | [#46](https://github.com/roy4222/fju-im-project/issues/46) | planned | [S01-03][模組01 帳號與權限] 建立「現在是誰在操作」的判定、稽核紀錄與操作帳本三個共用機制 |
| S01-04 | [#47](https://github.com/roy4222/fju-im-project/issues/47) | planned | [S01-04][模組01 帳號與權限] 先把全站的頁面骨架、側欄導覽與登入導向做出來（不含任何功能） |
| S01-05 | [#48](https://github.com/roy4222/fju-im-project/issues/48) | planned | [S01-05][模組01 帳號與權限] 管理員 A1 用一次性密碼首次登入、被強制改密後才能進後台，並能登出重登 |
| S01-06 | [#49](https://github.com/roy4222/fju-im-project/issues/49) | planned | [S01-06][模組02 屆別與年度流程] 管理員建立第一個屆別 115-TEST，並設為預設工作屆別與開放註冊屆別 |
| S01-07 | [#50](https://github.com/roy4222/fju-im-project/issues/50) | planned | [S01-07][模組10 檔案與服務維運] 最小檔案能力：安全地上傳一個檔、綁到資料上，並逐次授權下載 |
| S01-08 | [#51](https://github.com/roy4222/fju-im-project/issues/51) | planned | [S01-08][模組01 帳號與權限] 管理員上傳名單 CSV，先看預覽再一次匯入，原檔可下載 |
| S01-09 | [#52](https://github.com/roy4222/fju-im-project/issues/52) | planned | [S01-09][模組01 帳號與權限] 學生用 Email 與密碼註冊後停在等待審核頁，可以查看狀態並修改申請 |
| S01-10 | [#53](https://github.com/roy4222/fju-im-project/issues/53) | planned | [S01-10][模組01 帳號與權限] 管理員在待審清單看到名單比對結果，選核實方式後核准或退回 |
| S01-11 | [#54](https://github.com/roy4222/fju-im-project/issues/54) | planned | [S01-11][模組01 帳號與權限] 管理員停用、恢復或去識別化帳號，停用的人在舊頁面也立刻被登出 |
| S01-12 | [#55](https://github.com/roy4222/fju-im-project/issues/55) | planned | [S01-12][模組01 帳號與權限] 管理員替某個帳號核發只顯示一次的臨時密碼，對方登入後必須改密 |
| S01-13 | [#56](https://github.com/roy4222/fju-im-project/issues/56) | planned | [S01-13][模組01 帳號與權限] 管理員建立老師帳號或預授權老師 Email，老師首次登入補資料後進老師首頁 |
| S01-14 | [#57](https://github.com/roy4222/fju-im-project/issues/57) | planned | [S01-14][模組01 帳號與權限] 本人在帳號頁改聯絡資料、改密碼、連結 Google 或替 Google 帳號設密碼 |
| S01-15 | [#58](https://github.com/roy4222/fju-im-project/issues/58) | planned | [S01-15][模組01 帳號與權限] 登入或註冊連續失敗達門檻後，要先通過 Turnstile 人機驗證 |
| S01-16 | [#59](https://github.com/roy4222/fju-im-project/issues/59) | planned | [S01-16][模組01 帳號與權限] 帳號管理頁：已核准／待審核／已停用三個磚與可搜尋篩選的帳號表格 |
| S02-01 | [#60](https://github.com/roy4222/fju-im-project/issues/60) | planned | [S02-01][模組02 屆別與年度流程] 第三支 migration：新增屆別擴充欄、階段、活動、模擬鐘紀錄、屆別狀態事件與通知三表 |
| S02-02 | [#61](https://github.com/roy4222/fju-im-project/issues/61) | planned | [S02-02][模組02 屆別與年度流程] staging 上讓管理員把「今天」設成任意時間（模擬業務鐘），並留下每次設定的紀錄 |
| S02-03 | [#62](https://github.com/roy4222/fju-im-project/issues/62) | planned | [S02-03][模組08 站內通知與日曆] 建立「發事件」與「排到期工作」兩個共用介面，跟業務動作同一筆交易寫入 |
| S02-04 | [#63](https://github.com/roy4222/fju-im-project/issues/63) | planned | [S02-04][模組02 屆別與年度流程] 管理員在時間軸設定四個階段的開始日、年度結束日，並建立、改期或取消活動 |
| S02-05 | [#64](https://github.com/roy4222/fju-im-project/issues/64) | planned | [S02-05][模組02 屆別與年度流程] 屆別從籌備中變進行中留下紀錄，三個角色的首頁都顯示「尚未開始／階段 n／已結束」 |
| S02-06 | [#65](https://github.com/roy4222/fju-im-project/issues/65) | planned | [S02-06][模組08 站內通知與日曆] 啟動單一實例的背景工作進程，把事件投影成通知，並在 health 回報心跳 |
| S02-07 | [#66](https://github.com/roy4222/fju-im-project/issues/66) | planned | [S02-07][模組08 站內通知與日曆] 背景工作每 30 秒撿到期的工作分派給對應處理器，本票只掛測試用的 test_noop |
| S02-08 | [#67](https://github.com/roy4222/fju-im-project/issues/67) | planned | [S02-08][模組08 站內通知與日曆] 通知匣與鈴鐺：看通知、單筆或全部標已讀，並用管理端測試通知驗證投影 |
| S02-09 | [#68](https://github.com/roy4222/fju-im-project/issues/68) | planned | [S02-09][模組01 帳號與權限] 背景工作每 5 分鐘核對停用／恢復有沒有真的生效，過期的工作回收、必要時再排一次 |
| S03-01 | [#69](https://github.com/roy4222/fju-im-project/issues/69) | planned | [S03-01][模組03 分組、指導與產學] 第四支 migration：新增提案、邀請、占用、組別、成員、組長六張表 |
| S03-02 | [#70](https://github.com/roy4222/fju-im-project/issues/70) | planned | [S03-02][模組03 分組、指導與產學] 先做學生「我的組別」與管理員「分組」兩頁的殼、導覽與授權導向 |
| S03-03 | [#71](https://github.com/roy4222/fju-im-project/issues/71) | planned | [S03-03][模組03 分組、指導與產學] 學生打開「公開找組員」，同屆還沒分組的人在找組員名單看到他的姓名、學號與聯絡 Email |
| S03-04 | [#72](https://github.com/roy4222/fju-im-project/issues/72) | planned | [S03-04][模組02 屆別與年度流程] 管理員設定本屆提案的預設有效天數 |
| S03-05 | [#73](https://github.com/roy4222/fju-im-project/issues/73) | planned | [S03-05][模組03 分組、指導與產學] 學生選四位同學發起五人提案，五個人都被占住並收到邀請，提案頁顯示到期時間 |
| S03-06 | [#74](https://github.com/roy4222/fju-im-project/issues/74) | planned | [S03-06][模組03 分組、指導與產學] 五個人各自按確認，最後一位確認的瞬間組別成立、占用釋放、全員收到成立通知 |
| S03-07 | [#75](https://github.com/roy4222/fju-im-project/issues/75) | planned | [S03-07][模組03 分組、指導與產學] 拒絕、撤回、提案人撤回、到期、管理員作廢任一發生就終止提案並釋放所有人 |
| S03-08 | [#76](https://github.com/roy4222/fju-im-project/issues/76) | planned | [S03-08][模組03 分組、指導與產學] 管理員用表單直接建立三人例外組，填核可依據並指定組長 |
| S03-09 | [#77](https://github.com/roy4222/fju-im-project/issues/77) | planned | [S03-09][模組03 分組、指導與產學] 管理員填理由把組長換給另一位有效成員，全組收到通知並可查歷史 |
| S04-01 | [#78](https://github.com/roy4222/fju-im-project/issues/78) | planned | [S04-01][模組04 專題事務發布與編輯] 建立專題事務六張資料表與收件名單表 |
| S04-02 | [#79](https://github.com/roy4222/fju-im-project/issues/79) | planned | [S04-02][模組04 專題事務發布與編輯] 掛上管理員的專題事務後台與前台公告、規則、資源頁殼 |
| S04-03 | [#80](https://github.com/roy4222/fju-im-project/issues/80) | planned | [S04-03][模組04 專題事務發布與編輯] 管理員三步驟快速建立項目，或在完整編輯器編輯正文、欄位、受眾與時間 |
| S04-04 | [#81](https://github.com/roy4222/fju-im-project/issues/81) | planned | [S04-04][模組10 檔案與服務維運] 管理員在編輯器上傳附件與封面，並依受眾決定誰能下載 |
| S04-05 | [#82](https://github.com/roy4222/fju-im-project/issues/82) | planned | [S04-05][模組04 專題事務發布與編輯] 管理員發布項目：先過發布檢查，發布時同時建好收件名單、排截止並通知 |
| S04-06 | [#83](https://github.com/roy4222/fju-im-project/issues/83) | planned | [S04-06][模組04 專題事務發布與編輯] 管理員撤回、下架或重新發布項目，開放時間不因重新發布而重設 |
| S04-07 | [#84](https://github.com/roy4222/fju-im-project/issues/84) | planned | [S04-07][模組04 專題事務發布與編輯] 管理員小幅修改已發布內容並自選是否通知；有人作答後收件單位鎖定 |
| S04-08 | [#85](https://github.com/roy4222/fju-im-project/issues/85) | planned | [S04-08][模組09 公開展示與共用介面] 訪客在前台看到已發布的公告與規則，登入者看到資源；下架後打開網址會被告知下一步 |
| S04-09 | [#86](https://github.com/roy4222/fju-im-project/issues/86) | planned | [S04-09][模組08 站內通知與日曆] 學生首頁行事曆顯示屆別活動與收件截止 |
| S05-01 | [#87](https://github.com/roy4222/fju-im-project/issues/87) | planned | [S05-01][模組05 個人與組別繳交] 建立學生草稿與正式送出版本兩張資料表 |
| S05-02 | [#88](https://github.com/roy4222/fju-im-project/issues/88) | planned | [S05-02][模組05 個人與組別繳交] 掛上學生作業區、個人內容頁、本人繳交歷史與管理員名單分頁的頁殼 |
| S05-03 | [#89](https://github.com/roy4222/fju-im-project/issues/89) | planned | [S05-03][模組05 個人與組別繳交] 學生在作業區看到自己該交的項目與狀態，打開內容頁看到要填的欄位 |
| S05-04 | [#90](https://github.com/roy4222/fju-im-project/issues/90) | planned | [S05-04][模組05 個人與組別繳交] 學生儲存草稿，重新登入後還在；兩邊同時改會被要求重新載入 |
| S05-05 | [#91](https://github.com/roy4222/fju-im-project/issues/91) | planned | [S05-05][模組05 個人與組別繳交] 學生正式送出個人收件，拿到收件章回執；有回答後項目不能再撤回 |
| S05-06 | [#92](https://github.com/roy4222/fju-im-project/issues/92) | planned | [S05-06][模組05 個人與組別繳交] 學生截止前可以重送，連點只算一次，斷線後可查結果不會誤以為沒送出 |
| S05-07 | [#93](https://github.com/roy4222/fju-im-project/issues/93) | planned | [S05-07][模組05 個人與組別繳交] 學生查看自己每一次正式送出的版本歷史 |
| S05-08 | [#94](https://github.com/roy4222/fju-im-project/issues/94) | planned | [S05-08][模組05 個人與組別繳交] 管理員看名單頁、完成率與每個人的回答明細 |
| S06-01 | [#95](https://github.com/roy4222/fju-im-project/issues/95) | planned | [S06-01][模組03 分組、指導與產學] 建立主指導指派、合作案與合作案連結三張資料表 |
| S06-02 | [#96](https://github.com/roy4222/fju-im-project/issues/96) | planned | [S06-02][模組03 分組、指導與產學] 掛上老師組別頁、產學頁、合作案管理頁與管理員組別頁的動作入口 |
| S06-03 | [#97](https://github.com/roy4222/fju-im-project/issues/97) | planned | [S06-03][模組03 分組、指導與產學] 建立指導關係查詢、通知收件人規則，並替評分與簽核連動預留接點 |
| S06-04 | [#98](https://github.com/roy4222/fju-im-project/issues/98) | planned | [S06-04][模組03 分組、指導與產學] 老師認領還沒人指導的產學組，兩位老師同時搶只有一位成功 |
| S06-05 | [#99](https://github.com/roy4222/fju-im-project/issues/99) | planned | [S06-05][模組03 分組、指導與產學] 管理員逐組指派主指導，或解除現有的指派 |
| S06-06 | [#100](https://github.com/roy4222/fju-im-project/issues/100) | planned | [S06-06][模組03 分組、指導與產學] 管理員把一組換給另一位老師，對話框先列評分指派（本切片為空） |
| S06-07 | [#101](https://github.com/roy4222/fju-im-project/issues/101) | planned | [S06-07][模組03 分組、指導與產學] 管理員用 CSV 一次指派多組，先看六類預覽再逐列執行 |
| S06-08 | [#102](https://github.com/roy4222/fju-im-project/issues/102) | planned | [S06-08][模組03 分組、指導與產學] 老師建立、發布、下架、重新發布合作案，登入者看得到公開欄位、私有欄位只有案主與系辦看得到 |
| S06-09 | [#103](https://github.com/roy4222/fju-im-project/issues/103) | planned | [S06-09][模組03 分組、指導與產學] 產學組組長把組別連結到合作案、換案；案主或系辦解除連結並通知 |
| S06-10 | [#104](https://github.com/roy4222/fju-im-project/issues/104) | planned | [S06-10][模組03 分組、指導與產學] 組長在三個條件下自行改組別類型，否則交系辦處理關聯後才能改 |
| S06-11 | [#105](https://github.com/roy4222/fju-im-project/issues/105) | planned | [S06-11][模組03 分組、指導與產學] 管理員篩選、排序本屆組別名單並匯出 CSV 或 XLSX |
| S07-01 | [#106](https://github.com/roy4222/fju-im-project/issues/106) | planned | [S07-01][模組05 個人與組別繳交] 建立繳交附件表、主指導閱覽設定表與檔案回收用索引 |
| S07-02 | [#107](https://github.com/roy4222/fju-im-project/issues/107) | planned | [S07-02][模組05 個人與組別繳交] 掛上組別繳交頁的四個區塊與老師繳交矩陣的頁殼 |
| S07-03 | [#108](https://github.com/roy4222/fju-im-project/issues/108) | planned | [S07-03][模組05 個人與組別繳交] 全組共用一份草稿，任一組員儲存其他人都看得到；兩人同時改會被要求重新載入 |
| S07-04 | [#109](https://github.com/roy4222/fju-im-project/issues/109) | planned | [S07-04][模組10 檔案與服務維運] 組員上傳繳交檔案並附到草稿：合法的收、偽裝與超限的擋、中斷的留給回收 |
| S07-05 | [#110](https://github.com/roy4222/fju-im-project/issues/110) | planned | [S07-05][模組05 個人與組別繳交] 任一組員代表全組正式送出，拿到收件章回執，其他組員收到通知 |
| S07-06 | [#111](https://github.com/roy4222/fju-im-project/issues/111) | planned | [S07-06][模組10 檔案與服務維運] 繳交附件只有本組有效組員、目前主指導與系辦能下載 |
| S07-07 | [#112](https://github.com/roy4222/fju-im-project/issues/112) | planned | [S07-07][模組05 個人與組別繳交] 組員重送新版本，版本 1 不動；全組、主指導、系辦看到同一份歷史，名單頁算組別完成率 |
| S07-08 | [#113](https://github.com/roy4222/fju-im-project/issues/113) | planned | [S07-08][模組05 個人與組別繳交] 老師在繳交矩陣只看到自己現在指導的組別與各項目的繳交狀態 |
| S07-09 | [#114](https://github.com/roy4222/fju-im-project/issues/114) | planned | [S07-09][模組05 個人與組別繳交] 學生在「我的繳交」唯讀看自己的組別與個人版本；被移出的人只能看自己還在組裡時的版本 |
| S08-01 | [#115](https://github.com/roy4222/fju-im-project/issues/115) | planned | [S08-01][模組05 個人與組別繳交] 建立截止快照、快照註記與指定重開三張資料表 |
| S08-02 | [#116](https://github.com/roy4222/fju-im-project/issues/116) | planned | [S08-02][模組05 個人與組別繳交] 在名單頁掛上免填、移出、加回、重開等動作的入口與對話框 |
| S08-03 | [#117](https://github.com/roy4222/fju-im-project/issues/117) | planned | [S08-03][模組05 個人與組別繳交] 截止前核准的學生自動進名單，截止後不追加，停用時自動移出 |
| S08-04 | [#118](https://github.com/roy4222/fju-im-project/issues/118) | planned | [S08-04][模組05 個人與組別繳交] 管理員把人設為免填、恢復應填或移出名單，完成率跟著重算 |
| S08-05 | [#119](https://github.com/roy4222/fju-im-project/issues/119) | planned | [S08-05][模組05 個人與組別繳交] 截止一到自動拍下名單快照，並把學生頁鎖成唯讀 |
| S08-06 | [#120](https://github.com/roy4222/fju-im-project/issues/120) | planned | [S08-06][模組05 個人與組別繳交] 截止當下剛好在送出的版本，事後自動對帳補記 |
| S08-07 | [#121](https://github.com/roy4222/fju-im-project/issues/121) | planned | [S08-07][模組05 個人與組別繳交] 管理員只對某一組或某一人重新開放並讓他補交 |
| S08-08 | [#122](https://github.com/roy4222/fju-im-project/issues/122) | planned | [S08-08][模組04 專題事務發布與編輯] 管理員把整個收件項目的截止改期，全體看到新期限 |
| S08-09 | [#123](https://github.com/roy4222/fju-im-project/issues/123) | planned | [S08-09][模組04 專題事務發布與編輯] 已有人作答後改欄位結構，先預覽影響再套用，學生看到要補的差異 |
| S08-10 | [#124](https://github.com/roy4222/fju-im-project/issues/124) | planned | [S08-10][模組05 個人與組別繳交] 把被移出的人加回名單，以及改收件對象時先預覽再同步名單 |
| S08-11 | [#125](https://github.com/roy4222/fju-im-project/issues/125) | planned | [S08-11][模組08 站內通知與日曆] 截止後自動彙整逾期未交名單通知系辦 |
| S08-12 | [#126](https://github.com/roy4222/fju-im-project/issues/126) | planned | [S08-12][模組08 站內通知與日曆] 成組期結束時，還沒老師認領的產學組自動通知老師與系辦 |
| S08-13 | [#127](https://github.com/roy4222/fju-im-project/issues/127) | planned | [S08-13][模組05 個人與組別繳交] 管理員設定主指導可看個人回答，學生填寫前被告知，老師只看設定後的版本 |
| S08-14 | [#128](https://github.com/roy4222/fju-im-project/issues/128) | planned | [S08-14][模組05 個人與組別繳交] 完成率、徽章與待辦數字在名單頁、學生首頁、老師矩陣三處同步 |
| S08-15 | [#129](https://github.com/roy4222/fju-im-project/issues/129) | planned | [S08-15][工程基礎] 證明背景工作停機後能補跑、不重複，並提供封存預覽要用的未完成清單 |
| S08-16 | [#130](https://github.com/roy4222/fju-im-project/issues/130) | blocked-decision | [S08-16][模組08 站內通知與日曆] [BLOCKED D-05、D-06] 決定改期、改結構、改收件對象時要通知誰 |
| S08-17 | [#131](https://github.com/roy4222/fju-im-project/issues/131) | blocked-decision | [S08-17][模組05 個人與組別繳交] [BLOCKED D-13] 決定組別收件發布後才成立的組怎麼進名單 |
| S09-01 | [#132](https://github.com/roy4222/fju-im-project/issues/132) | blocked-dependency | [S09-01][模組03 分組、指導與產學] 管理員換組員：先看影響預覽，再執行、接任組長並通知全組 |
| S09-02 | [#133](https://github.com/roy4222/fju-im-project/issues/133) | blocked-dependency | [S09-02][模組03 分組、指導與產學] 管理員重派主指導時，逐筆決定評分指派怎麼處理，簽核只失效不自動建版 |
| S09-03 | [#134](https://github.com/roy4222/fju-im-project/issues/134) | blocked-decision | [S09-03][模組03 分組、指導與產學] [BLOCKED D-03] 管理員解散一組：預覽、填理由、執行，同時凍結繳交、停止評分、作廢簽核並通知相關人 |
| S09-04 | [#135](https://github.com/roy4222/fju-im-project/issues/135) | blocked-dependency | [S09-04][模組03 分組、指導與產學] 解散後誰還能看什麼：依解散當下的身分轉唯讀，管理員可查可匯出 |
| S10-01 | [#136](https://github.com/roy4222/fju-im-project/issues/136) | planned | [S10-01][模組06 評分與成績] 建立評分模組的九張資料表、不可變保護與角色權限 |
| S10-02 | [#137](https://github.com/roy4222/fju-im-project/issues/137) | planned | [S10-02][模組06 評分與成績] 管理員建立評分方案版本並發布，權重不合 100 被擋 |
| S10-03 | [#138](https://github.com/roy4222/fju-im-project/issues/138) | planned | [S10-03][模組06 評分與成績] 管理員設定每組每階段要幾份評分並指派老師，老師收到通知 |
| S10-04 | [#139](https://github.com/roy4222/fju-im-project/issues/139) | planned | [S10-04][模組06 評分與成績] 老師在評分工作台只看到自己的指派，填分數暫存 |
| S10-05 | [#140](https://github.com/roy4222/fju-im-project/issues/140) | planned | [S10-05][模組06 評分與成績] 老師正式送出分數，同一指派只採計一份，方案自此鎖定 |
| S10-06 | [#141](https://github.com/roy4222/fju-im-project/issues/141) | planned | [S10-06][模組06 評分與成績] 成績表顯示各組各階段平均與最終（兩位小數），並可看計算明細 |
| S10-07 | [#142](https://github.com/roy4222/fju-im-project/issues/142) | planned | [S10-07][模組06 評分與成績] 管理員更正最終結果，原值保留並列，需要復核時進待復核清單 |
| S10-08 | [#143](https://github.com/roy4222/fju-im-project/issues/143) | planned | [S10-08][模組06 評分與成績] 管理員退回某位老師的正式分數，老師收到通知後重送 |
| S10-09 | [#144](https://github.com/roy4222/fju-im-project/issues/144) | planned | [S10-09][模組06 評分與成績] 管理員移除評分指派時預覽三選一，預覽過期就要重做 |
| S10-10 | [#145](https://github.com/roy4222/fju-im-project/issues/145) | planned | [S10-10][模組06 評分與成績] 方案鎖定後，管理員用新版本改權重，套用前先看影響 |
| S10-11 | [#146](https://github.com/roy4222/fju-im-project/issues/146) | planned | [S10-11][模組06 評分與成績] 管理員匯出整屆成績為 XLSX 或 CSV，學號保留前導零 |
| S10-12 | [#147](https://github.com/roy4222/fju-im-project/issues/147) | planned | [S10-12][模組06 評分與成績] 學生任何頁面都看不到分數，並有可重跑的掃描報告證明 |
| S10-13 | [#148](https://github.com/roy4222/fju-im-project/issues/148) | planned | [S10-13][模組06 評分與成績] 老師被停用時成績表顯示缺評待處理、舊頁被拒；提供解散停止與封存預覽用的內部指令 |
| S11-01 | [#149](https://github.com/roy4222/fju-im-project/issues/149) | planned | [S11-01][模組07 線上簽核] 建立簽核五張表與精選三張表、不可變保護與角色權限 |
| S11-02 | [#150](https://github.com/roy4222/fju-im-project/issues/150) | planned | [S11-02][模組07 線上簽核] 做出三個角色的簽核頁與管理員精選頁的入口、空狀態與權限邊界 |
| S11-03 | [#151](https://github.com/roy4222/fju-im-project/issues/151) | planned | [S11-03][模組09 公開展示與共用介面] 管理員為一組建立精選草稿：題目、摘要、海報、影片連結（不發布） |
| S11-04 | [#152](https://github.com/roy4222/fju-im-project/issues/152) | planned | [S11-04][模組07 線上簽核] 管理員建立簽核版本：貼全文、選附件、快照參與者，最終文件授權從精選草稿凍結範圍 |
| S11-05 | [#153](https://github.com/roy4222/fju-im-project/issues/153) | planned | [S11-05][模組07 線上簽核] 學生逐人閱讀後同意或不同意，最後一位同意後輪到老師 |
| S11-06 | [#154](https://github.com/roy4222/fju-im-project/issues/154) | planned | [S11-06][模組07 線上簽核] 老師最後同意或退回；學生沒全同意前不能按 |
| S11-07 | [#155](https://github.com/roy4222/fju-im-project/issues/155) | planned | [S11-07][模組07 線上簽核] 管理員看整體進度與缺誰、重置或作廢版本；三個角色看到一致進度 |
| S11-08 | [#156](https://github.com/roy4222/fju-im-project/issues/156) | planned | [S11-08][模組07 線上簽核] 成員或主指導改變時目前版本自動失效、不自動建版；舊頁顯示原因等系辦建新版 |
| S11-09 | [#157](https://github.com/roy4222/fju-im-project/issues/157) | planned | [S11-09][模組07 線上簽核] 管理員匯出某版本的可列印頁與 CSV 明細 |
| S11-10 | [#158](https://github.com/roy4222/fju-im-project/issues/158) | planned | [S11-10][模組07 線上簽核] 提供「授權是否有效」「授權是否涵蓋」兩個查詢給公開閘門 |
| S11-11 | [#159](https://github.com/roy4222/fju-im-project/issues/159) | planned | [S11-11][模組07 線上簽核] 管理員一鍵提醒還沒同意的人，24 小時內不重複 |
| S11-12 | [#160](https://github.com/roy4222/fju-im-project/issues/160) | blocked-decision | [S11-12][模組07 線上簽核] [BLOCKED D-01] 決定「重開」是同一版再走一輪，還是建新版本 |
| S11-13 | [#161](https://github.com/roy4222/fju-im-project/issues/161) | blocked-decision | [S11-13][模組08 站內通知與日曆] [BLOCKED D-11] 決定簽核版本失效與被移出者說明要通知誰、文案帶什麼 |
| S12-01 | [#162](https://github.com/roy4222/fju-im-project/issues/162) | blocked-dependency | [S12-01][模組09 公開展示與共用介面] 建立外部授權、素材核閱、榮譽榜、素材來源、頁面中繼與備份紀錄八張資料表 |
| S12-02 | [#163](https://github.com/roy4222/fju-im-project/issues/163) | blocked-dependency | [S12-02][模組09 公開展示與共用介面] 管理員登記海報來源並做人工核閱，換檔就要重核 |
| S12-03 | [#164](https://github.com/roy4222/fju-im-project/issues/164) | blocked-dependency | [S12-03][模組09 公開展示與共用介面] 做出「能不能公開」的判定：先查個資、再查授權涵蓋、最後查素材核閱 |
| S12-04 | [#165](https://github.com/roy4222/fju-im-project/issues/165) | blocked-dependency | [S12-04][模組09 公開展示與共用介面] 管理員按發布把草稿凍結成不可改的公開版本，可撤稿與重新發布，並看到閘門逐項結果 |
| S12-05 | [#166](https://github.com/roy4222/fju-im-project/issues/166) | blocked-dependency | [S12-05][模組09 公開展示與共用介面] 訪客看得到已發布精選的列表、詳頁、海報與分享預覽，每次請求都先過閘門 |
| S12-06 | [#167](https://github.com/roy4222/fju-im-project/issues/167) | blocked-dependency | [S12-06][模組09 公開展示與共用介面] 授權一失效公開頁立刻擋住，背景工作隨後自動撤稿 |
| S12-07 | [#168](https://github.com/roy4222/fju-im-project/issues/168) | blocked-dependency | [S12-07][模組09 公開展示與共用介面] 管理員補登歷屆作品的外部授權，登入者看歷屆一覽，訪客看榮譽榜 |
| S12-08 | [#169](https://github.com/roy4222/fju-im-project/issues/169) | blocked-dependency | [S12-08][模組09 公開展示與共用介面] 管理員維護公開頁的標題與分享圖，網站自動產生 sitemap、robots 與 OG，並附效能報告 |
| S12-09 | [#170](https://github.com/roy4222/fju-im-project/issues/170) | blocked-dependency | [S12-09][模組09 公開展示與共用介面] 全站共用的 403 帶下一步、空頁、表格、手機寬度、鍵盤操作與可信回執 |
| S12-10 | [#171](https://github.com/roy4222/fju-im-project/issues/171) | blocked-dependency | [S12-10][模組08 站內通知與日曆] 補齊所有事件的通知規則，舊通知失權時顯示遮罩，點入重驗被拒，通知匣完整可用 |
| S12-11 | [#172](https://github.com/roy4222/fju-im-project/issues/172) | blocked-dependency | [S12-11][模組08 站內通知與日曆] 管理員維運頁：看背景工作心跳與失敗項目，並能重跑 |
| S12-12 | [#173](https://github.com/roy4222/fju-im-project/issues/173) | blocked-dependency | [S12-12][模組10 檔案與服務維運] 背景自動清理沒人引用的檔案與過期回執 |
| S12-13 | [#174](https://github.com/roy4222/fju-im-project/issues/174) | blocked-dependency | [S12-13][模組10 檔案與服務維運] 管理員檔案工作台：看真實用量、哪些檔案被引用、軟刪除沒人用的檔案 |
| S12-14 | [#175](https://github.com/roy4222/fju-im-project/issues/175) | blocked-dependency | [S12-14][模組10 檔案與服務維運] 管理員查稽核紀錄並安全匯出 |
| S12-15 | [#176](https://github.com/roy4222/fju-im-project/issues/176) | blocked-dependency | [S12-15][模組10 檔案與服務維運] 檔案工作台顯示備份與演練狀態，備份失敗才通知管理員 |
| S12-16 | [#177](https://github.com/roy4222/fju-im-project/issues/177) | blocked-dependency | [S12-16][模組09 公開展示與共用介面] 訪客用關鍵字搜尋已公開的精選 |
| S13-01 | [#178](https://github.com/roy4222/fju-im-project/issues/178) | blocked-dependency | [S13-01][模組02 屆別與年度流程] 老師與管理員在側欄切換工作屆別，進入任一屆都看到該屆狀態橫幅 |
| S13-02 | [#179](https://github.com/roy4222/fju-im-project/issues/179) | blocked-dependency | [S13-02][模組02 屆別與年度流程] 管理員封存前先看「還有哪些沒做完」的預覽清單 |
| S13-03 | [#180](https://github.com/roy4222/fju-im-project/issues/180) | blocked-dependency | [S13-03][模組02 屆別與年度流程] 管理員填理由封存一屆，該屆從此唯讀，排程中的到期工作一併取消 |
| S13-04 | [#181](https://github.com/roy4222/fju-im-project/issues/181) | blocked-decision | [S13-04][模組02 屆別與年度流程] [BLOCKED D-07] 管理員填理由解封已封存的屆，之後可再封存 |
| S13-05 | [#182](https://github.com/roy4222/fju-im-project/issues/182) | blocked-decision | [S13-05][模組02 屆別與年度流程] [BLOCKED D-08] 證明封存後全站只能讀不能寫，且封存與送出撞在一起時只有一方成功 |
| S13-06 | [#183](https://github.com/roy4222/fju-im-project/issues/183) | blocked-dependency | [S13-06][模組02 屆別與年度流程] 管理員建立下一屆 116-TEST 並啟用，兩屆同時進行而互不干擾 |
| S13-07 | [#184](https://github.com/roy4222/fju-im-project/issues/184) | blocked-decision | [S13-07][模組02 屆別與年度流程] [BLOCKED D-02] 管理員把學生從一屆調到另一屆，待辦跟著換、舊屆歷史保留 |
| S13-08 | [#185](https://github.com/roy4222/fju-im-project/issues/185) | blocked-dependency | [S13-08][模組08 站內通知與日曆] 通知匣可依屆別篩選，已封存屆的通知標「已封存（唯讀）」但仍可標已讀 |
| S13-09 | [#186](https://github.com/roy4222/fju-im-project/issues/186) | blocked-dependency | [S13-09][模組02 屆別與年度流程] 把 staging 的業務鐘往回撥，證明已作廢的提案不復活、已拍的快照不重拍 |
| S14-01 | [#187](https://github.com/roy4222/fju-im-project/issues/187) | planned | [S14-01][維運] 把校方 VM 第一次設定好：Docker、目錄、防火牆、部署帳號與憑證 |
| S14-02 | [#188](https://github.com/roy4222/fju-im-project/issues/188) | planned | [S14-02][維運] 把三組環境變數、Google 登入、Turnstile、映像拉取權限與 GitHub Secrets 填好，先不啟動服務 |
| S14-03 | [#189](https://github.com/roy4222/fju-im-project/issues/189) | blocked-dependency | [S14-03][維運] Roy 親自按下第一次 staging 部署，並實跑一次回滾 |
| S14-04 | [#190](https://github.com/roy4222/fju-im-project/issues/190) | blocked-dependency | [S14-04][維運] 每 5 分鐘自動探測站台健康，連續三次失敗才寄信給 Roy |
| S14-05 | [#191](https://github.com/roy4222/fju-im-project/issues/191) | blocked-dependency | [S14-05][模組10 檔案與服務維運] 做出備份程式：匯出資料庫、加密、上傳到 R2、寫一筆備份紀錄 |
| S14-06 | [#192](https://github.com/roy4222/fju-im-project/issues/192) | blocked-dependency | [S14-06][維運] staging 每天凌晨自動備份到 R2，並證明失敗時會通知 |
| S14-07 | [#193](https://github.com/roy4222/fju-im-project/issues/193) | blocked-dependency | [S14-07][模組10 檔案與服務維運] 背景工作每小時量一次磁碟用量，檔案工作台顯示真實數字與警戒等級 |
| S14-08 | [#194](https://github.com/roy4222/fju-im-project/issues/194) | blocked-dependency | [S14-08][維運] 做出隔離副本與演練副本的工具，分支劇本與還原演練有乾淨的起點 |
| S14-09 | [#195](https://github.com/roy4222/fju-im-project/issues/195) | blocked-dependency | [S14-09][模組10 檔案與服務維運] 從 R2 備份真的還原一次到演練副本，抽查資料並寫一筆演練紀錄 |
| S14-10 | [#196](https://github.com/roy4222/fju-im-project/issues/196) | blocked-dependency | [S14-10][維運] 在 staging 實跑四種故障處理：服務重啟、背景工作停擺、毒事件、磁碟 80% |
| S14-11 | [#197](https://github.com/roy4222/fju-im-project/issues/197) | blocked-decision | [S14-11][維運] [BLOCKED D-09] 在隔離副本上預演「staging 轉正式」的清庫與重建，不真的切換 |
| S14-12 | [#198](https://github.com/roy4222/fju-im-project/issues/198) | blocked-decision | [S14-12][模組08 站內通知與日曆] [BLOCKED D-04] 磁碟用量達 80% 時站內通知管理員並發外部告警 |

## 現在真正可以開始的票

- S00-01（#33）骨架、分層目錄、shared——唯一沒有前置的票。它完成後 S00-02、S00-03（需 T3 定案）、S00-06 才變成可開始；S00-11 需 T2；S00-05 的 GRANT 對象依 T1。
- 開工前 Roy 要確認：GitHub 方案（前置清單 §2.1 第 3 點（0））、T3 自動測試主要接縫、T2 CSP 方案；branch protection 在 S00-09 的 CI checks 出現後設定。

## 產生方式
`publish_backlog.py`（labels→build→create→link→verify；`gh-map.json` 為穩定票號→issue 對照，可續跑）；狀態由 `compute_status()` 依票級前置與總圖切片 gate 計算。
