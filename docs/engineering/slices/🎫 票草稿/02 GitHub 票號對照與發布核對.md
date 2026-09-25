> **2026-09-16 現行入口**：[開發進度總覽](</Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🛠️ 工程開發/🧱 實作切片/00 開發進度總覽.md>)。S00–S14 已各自成資料夾，每張票有完整內容與狀態快照。下方既有狀態／待開票／未開工敘述保留為歷史，不能當作本次現況。開工依新的 Session 並行規則；原產品與整體出場接受條件保留。

# GitHub 實作票總入口與發布核對

2026-09-13 Codex 接續發布收尾。15 個 epic、166 張實作票均已建立；本頁是票號導覽，工程正文仍維護於原票草稿與正文檔。

狀態：10 張直接決策受阻、33 張間接受阻、123 張 planned、0 張 ready。S00-01 (#33) 等 GitHub 方案確認後才可放行；T2/T3 依既定時點確認。發布不是開工或功能驗收；145 NOT_RUN、4 DEFERRED。

## Epic 入口

| Epic | GitHub | 成果 |
|---|---|---|
| E00 | [#18](https://github.com/roy4222/fju-im-project/issues/18) | 工程骨架與 CI：本機跑得起空殼、CI 綠燈、資料庫基礎表與角色就位 |
| E01 | [#19](https://github.com/roy4222/fju-im-project/issues/19) | 帳號註冊、審核與登入管理 |
| E02 | [#20](https://github.com/roy4222/fju-im-project/issues/20) | 屆別階段、業務時鐘、背景工作與通知匣 |
| E03 | [#21](https://github.com/roy4222/fju-im-project/issues/21) | 學生找組員、提案與逐人確認成組 |
| E04 | [#22](https://github.com/roy4222/fju-im-project/issues/22) | 系辦建立與發布專題事務、公開內容頁 |
| E05 | [#23](https://github.com/roy4222/fju-im-project/issues/23) | 學生個人填報與送出 |
| E06 | [#24](https://github.com/roy4222/fju-im-project/issues/24) | 指導老師認領、指派與產學合作案 |
| E07 | [#25](https://github.com/roy4222/fju-im-project/issues/25) | 組別共用草稿、上傳與正式送出、老師繳交矩陣 |
| E08 | [#26](https://github.com/roy4222/fju-im-project/issues/26) | 收件名單變動、截止快照、指定重開、逾期彙整 |
| E09 | [#27](https://github.com/roy4222/fju-im-project/issues/27) | 換成員、換組長、解散與解散後閱覽 |
| E10 | [#28](https://github.com/roy4222/fju-im-project/issues/28) | 評分方案、指派、評分、計算、退回、改派與匯出 |
| E11 | [#29](https://github.com/roy4222/fju-im-project/issues/29) | 線上簽核與最小精選草稿 |
| E12 | [#30](https://github.com/roy4222/fju-im-project/issues/30) | 公開精選、授權閘門、素材核閱、共用 UI、維運頁 |
| E13 | [#31](https://github.com/roy4222/fju-im-project/issues/31) | 封存與解封、多屆並行、下一屆建立 |
| E14 | [#32](https://github.com/roy4222/fju-im-project/issues/32) | VM、部署、備份、還原演練與告警的實跑 |

## 166 張實作票對照

| 票號 | GitHub | 內容 | 狀態 |
|---|---|---|---|
| S00-01 | [#33](https://github.com/roy4222/fju-im-project/issues/33) | 建立 web/ 專案骨架、六層目錄與共用的時鐘、結果、錯誤碼工具 | planned |
| S00-02 | [#34](https://github.com/roy4222/fju-im-project/issues/34) | 釘死 Better Auth 與 drizzle 版本，產出帳號四表的 schema 並核對欄名 | planned |
| S00-03 | [#35](https://github.com/roy4222/fju-im-project/issues/35) | 讓 pnpm test 能對真的 PostgreSQL 跑整合測試 | planned |
| S00-04 | [#36](https://github.com/roy4222/fju-im-project/issues/36) | 跑第一支 migration，把帳號四表、屆別與五張基礎表建進空資料庫 | planned |
| S00-05 | [#37](https://github.com/roy4222/fju-im-project/issues/37) | 建三個資料庫角色、依權限矩陣產生 GRANT、鎖住不可變表，並逐表測試 | planned |
| S00-06 | [#38](https://github.com/roy4222/fju-im-project/issues/38) | 用 lint 擋住跨層亂引用，並以七個反例與三個合法例證明規則有效 | planned |
| S00-07 | [#39](https://github.com/roy4222/fju-im-project/issues/39) | 用 Docker Compose 定義六個服務、Caddy 設定與 .env.example | planned |
| S00-08 | [#40](https://github.com/roy4222/fju-im-project/issues/40) | 做 /api/health 健康檢查端點與空殼首頁 | planned |
| S00-09 | [#41](https://github.com/roy4222/fju-im-project/issues/41) | 接上 CI 七道檢查，讓每個 PR 都自動跑型別、lint、測試、build、smoke 與套件稽核 | planned |
| S00-10 | [#42](https://github.com/roy4222/fju-im-project/issues/42) | 準備只能手動觸發且預設演練的部署流程（cd.yml 與 deploy.sh --dry-run） | planned |
| S00-11 | [#43](https://github.com/roy4222/fju-im-project/issues/43) | 全站加上 CSP 與安全標頭，擋掉未授權的注入腳本 | planned |
| S01-01 | [#44](https://github.com/roy4222/fju-im-project/issues/44) | 第二支 migration：在 S00 之上新增帳號模組九表與檔案兩表 | planned |
| S01-02 | [#45](https://github.com/roy4222/fju-im-project/issues/45) | 把 Better Auth 掛上網站，封鎖不該對外的路由，新帳號一律先進待審 | planned |
| S01-03 | [#46](https://github.com/roy4222/fju-im-project/issues/46) | 建立「現在是誰在操作」的判定、稽核紀錄與操作帳本三個共用機制 | planned |
| S01-04 | [#47](https://github.com/roy4222/fju-im-project/issues/47) | 先把全站的頁面骨架、側欄導覽與登入導向做出來（不含任何功能） | planned |
| S01-05 | [#48](https://github.com/roy4222/fju-im-project/issues/48) | 管理員 A1 用一次性密碼首次登入、被強制改密後才能進後台，並能登出重登 | planned |
| S01-06 | [#49](https://github.com/roy4222/fju-im-project/issues/49) | 管理員建立第一個屆別 115-TEST，並設為預設工作屆別與開放註冊屆別 | planned |
| S01-07 | [#50](https://github.com/roy4222/fju-im-project/issues/50) | 最小檔案能力：安全地上傳一個檔、綁到資料上，並逐次授權下載 | planned |
| S01-08 | [#51](https://github.com/roy4222/fju-im-project/issues/51) | 管理員上傳名單 CSV，先看預覽再一次匯入，原檔可下載 | planned |
| S01-09 | [#52](https://github.com/roy4222/fju-im-project/issues/52) | 學生用 Email 與密碼註冊後停在等待審核頁，可以查看狀態並修改申請 | planned |
| S01-10 | [#53](https://github.com/roy4222/fju-im-project/issues/53) | 管理員在待審清單看到名單比對結果，選核實方式後核准或退回 | planned |
| S01-11 | [#54](https://github.com/roy4222/fju-im-project/issues/54) | 管理員停用、恢復或去識別化帳號，停用的人在舊頁面也立刻被登出 | planned |
| S01-12 | [#55](https://github.com/roy4222/fju-im-project/issues/55) | 管理員替某個帳號核發只顯示一次的臨時密碼，對方登入後必須改密 | planned |
| S01-13 | [#56](https://github.com/roy4222/fju-im-project/issues/56) | 管理員建立老師帳號或預授權老師 Email，老師首次登入補資料後進老師首頁 | planned |
| S01-14 | [#57](https://github.com/roy4222/fju-im-project/issues/57) | 本人在帳號頁改聯絡資料、改密碼、連結 Google 或替 Google 帳號設密碼 | planned |
| S01-15 | [#58](https://github.com/roy4222/fju-im-project/issues/58) | 登入或註冊連續失敗達門檻後，要先通過 Turnstile 人機驗證 | planned |
| S01-16 | [#59](https://github.com/roy4222/fju-im-project/issues/59) | 帳號管理頁：已核准／待審核／已停用三個磚與可搜尋篩選的帳號表格 | planned |
| S02-01 | [#60](https://github.com/roy4222/fju-im-project/issues/60) | 第三支 migration：新增屆別擴充欄、階段、活動、模擬鐘紀錄、屆別狀態事件與通知三表 | planned |
| S02-02 | [#61](https://github.com/roy4222/fju-im-project/issues/61) | staging 上讓管理員把「今天」設成任意時間（模擬業務鐘），並留下每次設定的紀錄 | planned |
| S02-03 | [#62](https://github.com/roy4222/fju-im-project/issues/62) | 建立「發事件」與「排到期工作」兩個共用介面，跟業務動作同一筆交易寫入 | planned |
| S02-04 | [#63](https://github.com/roy4222/fju-im-project/issues/63) | 管理員在時間軸設定四個階段的開始日、年度結束日，並建立、改期或取消活動 | planned |
| S02-05 | [#64](https://github.com/roy4222/fju-im-project/issues/64) | 屆別從籌備中變進行中留下紀錄，三個角色的首頁都顯示「尚未開始／階段 n／已結束」 | planned |
| S02-06 | [#65](https://github.com/roy4222/fju-im-project/issues/65) | 啟動單一實例的背景工作進程，把事件投影成通知，並在 health 回報心跳 | planned |
| S02-07 | [#66](https://github.com/roy4222/fju-im-project/issues/66) | 背景工作每 30 秒撿到期的工作分派給對應處理器，本票只掛測試用的 test_noop | planned |
| S02-08 | [#67](https://github.com/roy4222/fju-im-project/issues/67) | 通知匣與鈴鐺：看通知、單筆或全部標已讀，並用管理端測試通知驗證投影 | planned |
| S02-09 | [#68](https://github.com/roy4222/fju-im-project/issues/68) | 背景工作每 5 分鐘核對停用／恢復有沒有真的生效，過期的工作回收、必要時再排一次 | planned |
| S03-01 | [#69](https://github.com/roy4222/fju-im-project/issues/69) | 第四支 migration：新增提案、邀請、占用、組別、成員、組長六張表 | planned |
| S03-02 | [#70](https://github.com/roy4222/fju-im-project/issues/70) | 先做學生「我的組別」與管理員「分組」兩頁的殼、導覽與授權導向 | planned |
| S03-03 | [#71](https://github.com/roy4222/fju-im-project/issues/71) | 學生打開「公開找組員」，同屆還沒分組的人在找組員名單看到他的姓名、學號與聯絡 Email | planned |
| S03-04 | [#72](https://github.com/roy4222/fju-im-project/issues/72) | 管理員設定本屆提案的預設有效天數 | planned |
| S03-05 | [#73](https://github.com/roy4222/fju-im-project/issues/73) | 學生選四位同學發起五人提案，五個人都被占住並收到邀請，提案頁顯示到期時間 | planned |
| S03-06 | [#74](https://github.com/roy4222/fju-im-project/issues/74) | 五個人各自按確認，最後一位確認的瞬間組別成立、占用釋放、全員收到成立通知 | planned |
| S03-07 | [#75](https://github.com/roy4222/fju-im-project/issues/75) | 拒絕、撤回、提案人撤回、到期、管理員作廢任一發生就終止提案並釋放所有人 | planned |
| S03-08 | [#76](https://github.com/roy4222/fju-im-project/issues/76) | 管理員用表單直接建立三人例外組，填核可依據並指定組長 | planned |
| S03-09 | [#77](https://github.com/roy4222/fju-im-project/issues/77) | 管理員填理由把組長換給另一位有效成員，全組收到通知並可查歷史 | planned |
| S04-01 | [#78](https://github.com/roy4222/fju-im-project/issues/78) | 建立專題事務六張資料表與收件名單表 | planned |
| S04-02 | [#79](https://github.com/roy4222/fju-im-project/issues/79) | 掛上管理員的專題事務後台與前台公告、規則、資源頁殼 | planned |
| S04-03 | [#80](https://github.com/roy4222/fju-im-project/issues/80) | 管理員三步驟快速建立項目，或在完整編輯器編輯正文、欄位、受眾與時間 | planned |
| S04-04 | [#81](https://github.com/roy4222/fju-im-project/issues/81) | 管理員在編輯器上傳附件與封面，並依受眾決定誰能下載 | planned |
| S04-05 | [#82](https://github.com/roy4222/fju-im-project/issues/82) | 管理員發布項目：先過發布檢查，發布時同時建好收件名單、排截止並通知 | planned |
| S04-06 | [#83](https://github.com/roy4222/fju-im-project/issues/83) | 管理員撤回、下架或重新發布項目，開放時間不因重新發布而重設 | planned |
| S04-07 | [#84](https://github.com/roy4222/fju-im-project/issues/84) | 管理員小幅修改已發布內容並自選是否通知；有人作答後收件單位鎖定 | planned |
| S04-08 | [#85](https://github.com/roy4222/fju-im-project/issues/85) | 訪客在前台看到已發布的公告與規則，登入者看到資源；下架後打開網址會被告知下一步 | planned |
| S04-09 | [#86](https://github.com/roy4222/fju-im-project/issues/86) | 學生首頁行事曆顯示屆別活動與收件截止 | planned |
| S05-01 | [#87](https://github.com/roy4222/fju-im-project/issues/87) | 建立學生草稿與正式送出版本兩張資料表 | planned |
| S05-02 | [#88](https://github.com/roy4222/fju-im-project/issues/88) | 掛上學生作業區、個人內容頁、本人繳交歷史與管理員名單分頁的頁殼 | planned |
| S05-03 | [#89](https://github.com/roy4222/fju-im-project/issues/89) | 學生在作業區看到自己該交的項目與狀態，打開內容頁看到要填的欄位 | planned |
| S05-04 | [#90](https://github.com/roy4222/fju-im-project/issues/90) | 學生儲存草稿，重新登入後還在；兩邊同時改會被要求重新載入 | planned |
| S05-05 | [#91](https://github.com/roy4222/fju-im-project/issues/91) | 學生正式送出個人收件，拿到收件章回執；有回答後項目不能再撤回 | planned |
| S05-06 | [#92](https://github.com/roy4222/fju-im-project/issues/92) | 學生截止前可以重送，連點只算一次，斷線後可查結果不會誤以為沒送出 | planned |
| S05-07 | [#93](https://github.com/roy4222/fju-im-project/issues/93) | 學生查看自己每一次正式送出的版本歷史 | planned |
| S05-08 | [#94](https://github.com/roy4222/fju-im-project/issues/94) | 管理員看名單頁、完成率與每個人的回答明細 | planned |
| S06-01 | [#95](https://github.com/roy4222/fju-im-project/issues/95) | 建立主指導指派、合作案與合作案連結三張資料表 | planned |
| S06-02 | [#96](https://github.com/roy4222/fju-im-project/issues/96) | 掛上老師組別頁、產學頁、合作案管理頁與管理員組別頁的動作入口 | planned |
| S06-03 | [#97](https://github.com/roy4222/fju-im-project/issues/97) | 建立指導關係查詢、通知收件人規則，並替評分與簽核連動預留接點 | planned |
| S06-04 | [#98](https://github.com/roy4222/fju-im-project/issues/98) | 老師認領還沒人指導的產學組，兩位老師同時搶只有一位成功 | planned |
| S06-05 | [#99](https://github.com/roy4222/fju-im-project/issues/99) | 管理員逐組指派主指導，或解除現有的指派 | planned |
| S06-06 | [#100](https://github.com/roy4222/fju-im-project/issues/100) | 管理員把一組換給另一位老師，對話框先列評分指派（本切片為空） | planned |
| S06-07 | [#101](https://github.com/roy4222/fju-im-project/issues/101) | 管理員用 CSV 一次指派多組，先看六類預覽再逐列執行 | planned |
| S06-08 | [#102](https://github.com/roy4222/fju-im-project/issues/102) | 老師建立、發布、下架、重新發布合作案，登入者看得到公開欄位、私有欄位只有案主與系辦看得到 | planned |
| S06-09 | [#103](https://github.com/roy4222/fju-im-project/issues/103) | 產學組組長把組別連結到合作案、換案；案主或系辦解除連結並通知 | planned |
| S06-10 | [#104](https://github.com/roy4222/fju-im-project/issues/104) | 組長在三個條件下自行改組別類型，否則交系辦處理關聯後才能改 | planned |
| S06-11 | [#105](https://github.com/roy4222/fju-im-project/issues/105) | 管理員篩選、排序本屆組別名單並匯出 CSV 或 XLSX | planned |
| S07-01 | [#106](https://github.com/roy4222/fju-im-project/issues/106) | 建立繳交附件表、主指導閱覽設定表與檔案回收用索引 | planned |
| S07-02 | [#107](https://github.com/roy4222/fju-im-project/issues/107) | 掛上組別繳交頁的四個區塊與老師繳交矩陣的頁殼 | planned |
| S07-03 | [#108](https://github.com/roy4222/fju-im-project/issues/108) | 全組共用一份草稿，任一組員儲存其他人都看得到；兩人同時改會被要求重新載入 | planned |
| S07-04 | [#109](https://github.com/roy4222/fju-im-project/issues/109) | 組員上傳繳交檔案並附到草稿：合法的收、偽裝與超限的擋、中斷的留給回收 | planned |
| S07-05 | [#110](https://github.com/roy4222/fju-im-project/issues/110) | 任一組員代表全組正式送出，拿到收件章回執，其他組員收到通知 | planned |
| S07-06 | [#111](https://github.com/roy4222/fju-im-project/issues/111) | 繳交附件只有本組有效組員、目前主指導與系辦能下載 | planned |
| S07-07 | [#112](https://github.com/roy4222/fju-im-project/issues/112) | 組員重送新版本，版本 1 不動；全組、主指導、系辦看到同一份歷史，名單頁算組別完成率 | planned |
| S07-08 | [#113](https://github.com/roy4222/fju-im-project/issues/113) | 老師在繳交矩陣只看到自己現在指導的組別與各項目的繳交狀態 | planned |
| S07-09 | [#114](https://github.com/roy4222/fju-im-project/issues/114) | 學生在「我的繳交」唯讀看自己的組別與個人版本；被移出的人只能看自己還在組裡時的版本 | planned |
| S08-01 | [#115](https://github.com/roy4222/fju-im-project/issues/115) | 建立截止快照、快照註記與指定重開三張資料表 | planned |
| S08-02 | [#116](https://github.com/roy4222/fju-im-project/issues/116) | 在名單頁掛上免填、移出、加回、重開等動作的入口與對話框 | planned |
| S08-03 | [#117](https://github.com/roy4222/fju-im-project/issues/117) | 截止前核准的學生自動進名單，截止後不追加，停用時自動移出 | planned |
| S08-04 | [#118](https://github.com/roy4222/fju-im-project/issues/118) | 管理員把人設為免填、恢復應填或移出名單，完成率跟著重算 | planned |
| S08-05 | [#119](https://github.com/roy4222/fju-im-project/issues/119) | 截止一到自動拍下名單快照，並把學生頁鎖成唯讀 | planned |
| S08-06 | [#120](https://github.com/roy4222/fju-im-project/issues/120) | 截止當下剛好在送出的版本，事後自動對帳補記 | planned |
| S08-07 | [#121](https://github.com/roy4222/fju-im-project/issues/121) | 管理員只對某一組或某一人重新開放並讓他補交 | planned |
| S08-08 | [#122](https://github.com/roy4222/fju-im-project/issues/122) | 管理員把整個收件項目的截止改期，全體看到新期限 | planned |
| S08-09 | [#123](https://github.com/roy4222/fju-im-project/issues/123) | 已有人作答後改欄位結構，先預覽影響再套用，學生看到要補的差異 | planned |
| S08-10 | [#124](https://github.com/roy4222/fju-im-project/issues/124) | 把被移出的人加回名單，以及改收件對象時先預覽再同步名單 | planned |
| S08-11 | [#125](https://github.com/roy4222/fju-im-project/issues/125) | 截止後自動彙整逾期未交名單通知系辦 | planned |
| S08-12 | [#126](https://github.com/roy4222/fju-im-project/issues/126) | 成組期結束時，還沒老師認領的產學組自動通知老師與系辦 | planned |
| S08-13 | [#127](https://github.com/roy4222/fju-im-project/issues/127) | 管理員設定主指導可看個人回答，學生填寫前被告知，老師只看設定後的版本 | planned |
| S08-14 | [#128](https://github.com/roy4222/fju-im-project/issues/128) | 完成率、徽章與待辦數字在名單頁、學生首頁、老師矩陣三處同步 | planned |
| S08-15 | [#129](https://github.com/roy4222/fju-im-project/issues/129) | 證明背景工作停機後能補跑、不重複，並提供封存預覽要用的未完成清單 | planned |
| S08-16 | [#130](https://github.com/roy4222/fju-im-project/issues/130) | [BLOCKED D-05、D-06] 決定改期、改結構、改收件對象時要通知誰 | blocked-decision |
| S08-17 | [#131](https://github.com/roy4222/fju-im-project/issues/131) | [BLOCKED D-13] 決定組別收件發布後才成立的組怎麼進名單 | blocked-decision |
| S09-01 | [#132](https://github.com/roy4222/fju-im-project/issues/132) | 管理員換組員：先看影響預覽，再執行、接任組長並通知全組 | blocked-dependency |
| S09-02 | [#133](https://github.com/roy4222/fju-im-project/issues/133) | 管理員重派主指導時，逐筆決定評分指派怎麼處理，簽核只失效不自動建版 | blocked-dependency |
| S09-03 | [#134](https://github.com/roy4222/fju-im-project/issues/134) | [BLOCKED D-03] 管理員解散一組：預覽、填理由、執行，同時凍結繳交、停止評分、作廢簽核並通知相關人 | blocked-decision |
| S09-04 | [#135](https://github.com/roy4222/fju-im-project/issues/135) | 解散後誰還能看什麼：依解散當下的身分轉唯讀，管理員可查可匯出 | blocked-dependency |
| S10-01 | [#136](https://github.com/roy4222/fju-im-project/issues/136) | 建立評分模組的九張資料表、不可變保護與角色權限 | planned |
| S10-02 | [#137](https://github.com/roy4222/fju-im-project/issues/137) | 管理員建立評分方案版本並發布，權重不合 100 被擋 | planned |
| S10-03 | [#138](https://github.com/roy4222/fju-im-project/issues/138) | 管理員設定每組每階段要幾份評分並指派老師，老師收到通知 | planned |
| S10-04 | [#139](https://github.com/roy4222/fju-im-project/issues/139) | 老師在評分工作台只看到自己的指派，填分數暫存 | planned |
| S10-05 | [#140](https://github.com/roy4222/fju-im-project/issues/140) | 老師正式送出分數，同一指派只採計一份，方案自此鎖定 | planned |
| S10-06 | [#141](https://github.com/roy4222/fju-im-project/issues/141) | 成績表顯示各組各階段平均與最終（兩位小數），並可看計算明細 | planned |
| S10-07 | [#142](https://github.com/roy4222/fju-im-project/issues/142) | 管理員更正最終結果，原值保留並列，需要復核時進待復核清單 | planned |
| S10-08 | [#143](https://github.com/roy4222/fju-im-project/issues/143) | 管理員退回某位老師的正式分數，老師收到通知後重送 | planned |
| S10-09 | [#144](https://github.com/roy4222/fju-im-project/issues/144) | 管理員移除評分指派時預覽三選一，預覽過期就要重做 | planned |
| S10-10 | [#145](https://github.com/roy4222/fju-im-project/issues/145) | 方案鎖定後，管理員用新版本改權重，套用前先看影響 | planned |
| S10-11 | [#146](https://github.com/roy4222/fju-im-project/issues/146) | 管理員匯出整屆成績為 XLSX 或 CSV，學號保留前導零 | planned |
| S10-12 | [#147](https://github.com/roy4222/fju-im-project/issues/147) | 學生任何頁面都看不到分數，並有可重跑的掃描報告證明 | planned |
| S10-13 | [#148](https://github.com/roy4222/fju-im-project/issues/148) | 老師被停用時成績表顯示缺評待處理、舊頁被拒；提供解散停止與封存預覽用的內部指令 | planned |
| S11-01 | [#149](https://github.com/roy4222/fju-im-project/issues/149) | 建立簽核五張表與精選三張表、不可變保護與角色權限 | planned |
| S11-02 | [#150](https://github.com/roy4222/fju-im-project/issues/150) | 做出三個角色的簽核頁與管理員精選頁的入口、空狀態與權限邊界 | planned |
| S11-03 | [#151](https://github.com/roy4222/fju-im-project/issues/151) | 管理員為一組建立精選草稿：題目、摘要、海報、影片連結（不發布） | planned |
| S11-04 | [#152](https://github.com/roy4222/fju-im-project/issues/152) | 管理員建立簽核版本：貼全文、選附件、快照參與者，最終文件授權從精選草稿凍結範圍 | planned |
| S11-05 | [#153](https://github.com/roy4222/fju-im-project/issues/153) | 學生逐人閱讀後同意或不同意，最後一位同意後輪到老師 | planned |
| S11-06 | [#154](https://github.com/roy4222/fju-im-project/issues/154) | 老師最後同意或退回；學生沒全同意前不能按 | planned |
| S11-07 | [#155](https://github.com/roy4222/fju-im-project/issues/155) | 管理員看整體進度與缺誰、重置或作廢版本；三個角色看到一致進度 | planned |
| S11-08 | [#156](https://github.com/roy4222/fju-im-project/issues/156) | 成員或主指導改變時目前版本自動失效、不自動建版；舊頁顯示原因等系辦建新版 | planned |
| S11-09 | [#157](https://github.com/roy4222/fju-im-project/issues/157) | 管理員匯出某版本的可列印頁與 CSV 明細 | planned |
| S11-10 | [#158](https://github.com/roy4222/fju-im-project/issues/158) | 提供「授權是否有效」「授權是否涵蓋」兩個查詢給公開閘門 | planned |
| S11-11 | [#159](https://github.com/roy4222/fju-im-project/issues/159) | 管理員一鍵提醒還沒同意的人，24 小時內不重複 | planned |
| S11-12 | [#160](https://github.com/roy4222/fju-im-project/issues/160) | [BLOCKED D-01] 決定「重開」是同一版再走一輪，還是建新版本 | blocked-decision |
| S11-13 | [#161](https://github.com/roy4222/fju-im-project/issues/161) | [BLOCKED D-11] 決定簽核版本失效與被移出者說明要通知誰、文案帶什麼 | blocked-decision |
| S12-01 | [#162](https://github.com/roy4222/fju-im-project/issues/162) | 建立外部授權、素材核閱、榮譽榜、素材來源、頁面中繼與備份紀錄八張資料表 | blocked-dependency |
| S12-02 | [#163](https://github.com/roy4222/fju-im-project/issues/163) | 管理員登記海報來源並做人工核閱，換檔就要重核 | blocked-dependency |
| S12-03 | [#164](https://github.com/roy4222/fju-im-project/issues/164) | 做出「能不能公開」的判定：先查個資、再查授權涵蓋、最後查素材核閱 | blocked-dependency |
| S12-04 | [#165](https://github.com/roy4222/fju-im-project/issues/165) | 管理員按發布把草稿凍結成不可改的公開版本，可撤稿與重新發布，並看到閘門逐項結果 | blocked-dependency |
| S12-05 | [#166](https://github.com/roy4222/fju-im-project/issues/166) | 訪客看得到已發布精選的列表、詳頁、海報與分享預覽，每次請求都先過閘門 | blocked-dependency |
| S12-06 | [#167](https://github.com/roy4222/fju-im-project/issues/167) | 授權一失效公開頁立刻擋住，背景工作隨後自動撤稿 | blocked-dependency |
| S12-07 | [#168](https://github.com/roy4222/fju-im-project/issues/168) | 管理員補登歷屆作品的外部授權，登入者看歷屆一覽，訪客看榮譽榜 | blocked-dependency |
| S12-08 | [#169](https://github.com/roy4222/fju-im-project/issues/169) | 管理員維護公開頁的標題與分享圖，網站自動產生 sitemap、robots 與 OG，並附效能報告 | blocked-dependency |
| S12-09 | [#170](https://github.com/roy4222/fju-im-project/issues/170) | 全站共用的 403 帶下一步、空頁、表格、手機寬度、鍵盤操作與可信回執 | blocked-dependency |
| S12-10 | [#171](https://github.com/roy4222/fju-im-project/issues/171) | 補齊所有事件的通知規則，舊通知失權時顯示遮罩，點入重驗被拒，通知匣完整可用 | blocked-dependency |
| S12-11 | [#172](https://github.com/roy4222/fju-im-project/issues/172) | 管理員維運頁：看背景工作心跳與失敗項目，並能重跑 | blocked-dependency |
| S12-12 | [#173](https://github.com/roy4222/fju-im-project/issues/173) | 背景自動清理沒人引用的檔案與過期回執 | blocked-dependency |
| S12-13 | [#174](https://github.com/roy4222/fju-im-project/issues/174) | 管理員檔案工作台：看真實用量、哪些檔案被引用、軟刪除沒人用的檔案 | blocked-dependency |
| S12-14 | [#175](https://github.com/roy4222/fju-im-project/issues/175) | 管理員查稽核紀錄並安全匯出 | blocked-dependency |
| S12-15 | [#176](https://github.com/roy4222/fju-im-project/issues/176) | 檔案工作台顯示備份與演練狀態，備份失敗才通知管理員 | blocked-dependency |
| S12-16 | [#177](https://github.com/roy4222/fju-im-project/issues/177) | 訪客用關鍵字搜尋已公開的精選 | blocked-dependency |
| S13-01 | [#178](https://github.com/roy4222/fju-im-project/issues/178) | 老師與管理員在側欄切換工作屆別，進入任一屆都看到該屆狀態橫幅 | blocked-dependency |
| S13-02 | [#179](https://github.com/roy4222/fju-im-project/issues/179) | 管理員封存前先看「還有哪些沒做完」的預覽清單 | blocked-dependency |
| S13-03 | [#180](https://github.com/roy4222/fju-im-project/issues/180) | 管理員填理由封存一屆，該屆從此唯讀，排程中的到期工作一併取消 | blocked-dependency |
| S13-04 | [#181](https://github.com/roy4222/fju-im-project/issues/181) | [BLOCKED D-07] 管理員填理由解封已封存的屆，之後可再封存 | blocked-decision |
| S13-05 | [#182](https://github.com/roy4222/fju-im-project/issues/182) | [BLOCKED D-08] 證明封存後全站只能讀不能寫，且封存與送出撞在一起時只有一方成功 | blocked-decision |
| S13-06 | [#183](https://github.com/roy4222/fju-im-project/issues/183) | 管理員建立下一屆 116-TEST 並啟用，兩屆同時進行而互不干擾 | blocked-dependency |
| S13-07 | [#184](https://github.com/roy4222/fju-im-project/issues/184) | [BLOCKED D-02] 管理員把學生從一屆調到另一屆，待辦跟著換、舊屆歷史保留 | blocked-decision |
| S13-08 | [#185](https://github.com/roy4222/fju-im-project/issues/185) | 通知匣可依屆別篩選，已封存屆的通知標「已封存（唯讀）」但仍可標已讀 | blocked-dependency |
| S13-09 | [#186](https://github.com/roy4222/fju-im-project/issues/186) | 把 staging 的業務鐘往回撥，證明已作廢的提案不復活、已拍的快照不重拍 | blocked-dependency |
| S14-01 | [#187](https://github.com/roy4222/fju-im-project/issues/187) | 把校方 VM 第一次設定好：Docker、目錄、防火牆、部署帳號與憑證 | planned |
| S14-02 | [#188](https://github.com/roy4222/fju-im-project/issues/188) | 把三組環境變數、Google 登入、Turnstile、映像拉取權限與 GitHub Secrets 填好，先不啟動服務 | planned |
| S14-03 | [#189](https://github.com/roy4222/fju-im-project/issues/189) | Roy 親自按下第一次 staging 部署，並實跑一次回滾 | blocked-dependency |
| S14-04 | [#190](https://github.com/roy4222/fju-im-project/issues/190) | 每 5 分鐘自動探測站台健康，連續三次失敗才寄信給 Roy | blocked-dependency |
| S14-05 | [#191](https://github.com/roy4222/fju-im-project/issues/191) | 做出備份程式：匯出資料庫、加密、上傳到 R2、寫一筆備份紀錄 | blocked-dependency |
| S14-06 | [#192](https://github.com/roy4222/fju-im-project/issues/192) | staging 每天凌晨自動備份到 R2，並證明失敗時會通知 | blocked-dependency |
| S14-07 | [#193](https://github.com/roy4222/fju-im-project/issues/193) | 背景工作每小時量一次磁碟用量，檔案工作台顯示真實數字與警戒等級 | blocked-dependency |
| S14-08 | [#194](https://github.com/roy4222/fju-im-project/issues/194) | 做出隔離副本與演練副本的工具，分支劇本與還原演練有乾淨的起點 | blocked-dependency |
| S14-09 | [#195](https://github.com/roy4222/fju-im-project/issues/195) | 從 R2 備份真的還原一次到演練副本，抽查資料並寫一筆演練紀錄 | blocked-dependency |
| S14-10 | [#196](https://github.com/roy4222/fju-im-project/issues/196) | 在 staging 實跑四種故障處理：服務重啟、背景工作停擺、毒事件、磁碟 80% | blocked-dependency |
| S14-11 | [#197](https://github.com/roy4222/fju-im-project/issues/197) | [BLOCKED D-09] 在隔離副本上預演「staging 轉正式」的清庫與重建，不真的切換 | blocked-decision |
| S14-12 | [#198](https://github.com/roy4222/fju-im-project/issues/198) | [BLOCKED D-04] 磁碟用量達 80% 時站內通知管理員並發外部告警 | blocked-decision |

## 發布收尾與驗證範圍

- 沿用既有票號，不重新開票。校正誤附的決策標籤；S00-01 取消 ready。
- S09-01 白話摘要明寫管理員才能換組長、指向 S03-09；成員異動和 S11-08 摘要明寫 current complete 也失效。
- GRD-14 是案例編號，不是 D-14 決策；B04 對齊停用保留草稿及重新啟用規則。
- spec review #6、#8–#17 保留全文/歷史討論，更新固定來源與 epic 入口。
- 核對正式票號、父 epic/前置連結、分類標籤、正文六節、固定圖片/文件路徑。圖片路徑存在不等於已驗每個瀏覽器的登入載圖。
- 主工作樹的 prototype 與未提交文件鏡像保留；PR #7 尚未合併。
- 沒有新增產品決策、沒有正式碼實作、VM 操作或驗收 PASS。
