# 三角色改版複測｜綜合評價與明日接手

整理時間：2026-09-10T21:44:37+08:00。依三個角色當下已保存的完整報告與原型整理；受測網站版本為 `8e1cff87eacbe14cb86b2bc87e3b5842cbf4cf08`，localhost:3100，fixtures 原型。這是報告綜合，沒有再次執行全站測試或改動產品。

## 綜合評價

**這輪有實質改善，但尚未達到「可以信任地辦完事情」，視覺也仍以原版整理為主。**

功能：空白與超界輸入阻擋、老師切組網址、同分頁評分保存、指定組別與零欄位檢查、管理員部分篩選與行政對話框已有進展。不能說完全沒改。

UX：主要缺口由「入口不存在」轉成「操作有回饋，結果卻沒有一致保存或反映」。成功提示、回列表、重整、其他角色檢視還沒接成可靠流程。這比卡片漂不漂亮更直接影響使用信心。

UI：老師評分列、學生手機清單與管理員編輯順序變清楚；但整體仍沿用大歡迎色塊、圓角面板、原有配色與布局語彙。因此第一眼像舊版是合理觀察。下一輪應比較資訊結構與視覺方向，而非只加特效。

正式狀態：原型可拿來評選，不能把它當正式校務驗收。真後端、跨使用者同步、檔案、通知、備份與完整權限仍須獨立驗證。三案 HTML 是提案，不是3100已改好。

## 明天先處理的重點

| 優先 | 工作 | 三角色證據與影響 |
|---|---|---|
| 1 | 保存與離開保護 | 學生暫存成功後丟字；老師側欄離開未存輸入會遺失；簽核／認領／產學成功後狀態不延續；管理員重開未保留。應逐流程列保存層，不能全用toast當完成。 |
| 2 | 同版本內容共用 | mi-011／第07組／v2標頭一致，學生與系辦卻在出席人數、組員欄、連結三處不同。以不可變欄位快照供各角色讀取。 |
| 3 | 規格正確性 | 老師82.15被顯示82.2；報告核對規格要求兩位half-up。產學「網際網路公開含聯絡資訊」與最新受眾規則衝突；未證實實際外洩。 |
| 4 | 編輯器完成一次真文章流程 | 同草稿ID已有修復，但快速建立正文轉完整編輯仍空白；圖片／連結預覽顯示Markdown語法。需驗寫入→保存→重開→渲染→發布的完整內容。 |
| 5 | 手機與任務摘要 | 390px學生時間軸摘要擠壓，360px反而正常；送出後首頁／徽章仍舊，管理員返回列表丟篩選。核對中間斷點與動作後狀態。 |

同意書還要讓老師先讀到完整正文，明列組別、版本，再做個人決定。不可只補一顆可按的同意按鈕。

## 三案評選建議

| 角色 | A | B：建議先試 | C |
|---|---|---|---|
| 學生 | 保留四區與蛇形、精修 | 任務優先：期限、下一步與憑據 | 校務手冊章節，特色較強 |
| 老師 | 評閱桌，接近原版 | 連續評閱：材料與評分靠近 | 評閱冊，目錄／頁緣識別 |
| 管理員 | 三欄全局核對 | 按內容→收件→發布→預覽順序 | 文件畫布，文章本身為中心 |

三份報告都推薦B，是設計判斷，並非真人測試已證明勝出。明天先各做一個任務，再看C有哪些細節值得吸收；不要把三個C的裝飾全部拼進同一網站。共同方向可用紙白、深藍、少量橘色書籤與收件章，讓特色服務於定位與完成回饋。

## 報告、原型與證據

三個角色完整報告與HTML檔已確認存在。學生已收到完成回報且Vault複本已確認；老師／管理員此摘要以當下已保存正文為準，尚未在本任務收到最終收尾回報或核實Vault複本。以下連結指向實際存在的工作樹檔案。

| 角色 | 報告 | 原型 | 全部文件 |
|---|---|---|---|
| 學生 | [完整報告](</Users/lubaiyu/.codex/worktrees/a433/fju-project/docs/reviews/2026-09-10-role-ux-retest/student/REPORT.md>) | [A／B／C 原型](</Users/lubaiyu/.codex/worktrees/a433/fju-project/docs/reviews/2026-09-10-role-ux-retest/student/concepts/index.html>) | [文件與證據入口](</Users/lubaiyu/.codex/worktrees/a433/fju-project/docs/reviews/2026-09-10-role-ux-retest/student/README.md>) |
| 老師 | [完整報告](</Users/lubaiyu/.codex/worktrees/f9cd/fju-project/docs/reviews/2026-09-10-role-ux-retest/teacher/REPORT.md>) | [A／B／C 原型](</Users/lubaiyu/.codex/worktrees/f9cd/fju-project/docs/reviews/2026-09-10-role-ux-retest/teacher/concepts/index.html>) | [文件與證據入口](</Users/lubaiyu/.codex/worktrees/f9cd/fju-project/docs/reviews/2026-09-10-role-ux-retest/teacher/README.md>) |
| 管理員 | [完整報告](</Users/lubaiyu/.codex/worktrees/adf9/fju-project/docs/reviews/2026-09-10-role-ux-retest/admin/REPORT.md>) | [A／B／C 原型](</Users/lubaiyu/.codex/worktrees/adf9/fju-project/docs/reviews/2026-09-10-role-ux-retest/admin/concepts/index.html>) | [文件與證據入口](</Users/lubaiyu/.codex/worktrees/adf9/fju-project/docs/reviews/2026-09-10-role-ux-retest/admin/README.md>) |

HTML以瀏覽器開啟，使用頁首A／B／C切換。證據及提案限制由各角色README進入。

## 原始文件與第一輪脈絡

- [第一輪三角色審查入口](/Users/lubaiyu/fju-project/docs/reviews/2026-09-10-role-ux/README.md)
- [第一輪學生報告](/Users/lubaiyu/fju-project/docs/reviews/2026-09-10-role-ux/student.md)
- [第一輪老師報告](/Users/lubaiyu/fju-project/docs/reviews/2026-09-10-role-ux/teacher.md)
- [第一輪管理員報告](/Users/lubaiyu/fju-project/docs/reviews/2026-09-10-role-ux/admin.md)
- [工程師逐項改版回覆](/Users/lubaiyu/fju-project/docs/reviews/2026-09-10-role-ux/RESPONSE.md)
- [後台頁面清單與改版規則](/Users/lubaiyu/fju-project/docs/DASHBOARD-PAGES.md)
- [Vault完整產品規格](</Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🧭 設計與決策/📋 完整產品規格.md>)
- [PR #5](https://github.com/roy4222/fju-im-project/pull/5)：使用者提供的改版PR；本輪未另查合併狀態。

## 明天建議順序

1. 先讀本頁重點，再各開B案做一次學生查作業、老師連評兩組、系辦建公告／收件。
2. 記下選A/B/C及想保留的細節，分開決定操作結構與視覺特色。
3. 把上方五類問題轉成具體修正與驗收案例，先處理保存、內容一致及規格錯誤。
4. 選定後才搬原型設計，最後以同一作業／組別／版本跨角色再驗。今晚不需再改版或做決策。
