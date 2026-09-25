---
type: sop
project: FJU IM Project
updated: 2026-09-23
execution_status: NOT_RUN
---
# SOP 06｜staging→正式切換（獨立程序，不在 CD）

> **2026-09-23 v3：本程序的清庫切換不再需要（Roy 定案，[主控台交接](</Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🛠️ 工程開發/📝 開發紀錄/2026-09-23 主控台交接.md>) 第 2 節；總表見 [05 執行手冊](</Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🛠️ 工程開發/🧱 實作切片/05 執行手冊.md>) §6）。** 正式站 `fju.roy422.dev` 是同一台 VM 上另一組 Compose project（`fju-prod`），自己的 PostgreSQL、volume、`.env`（秘密存 Doppler `prd`），先建好維持空站，不從測試站搬資料。新的 Gate 是：
>
> 1. 同一映像先部署到測試站 `test.fju.roy422.dev`（`fju-test`）。
> 2. Roy 在該里程碑的 GitHub 驗收 issue 留言接受。
> 3. 同一個 tag／digest 部署到 `fju-prod`；首次部署跑 `migrate`＋`seed:a1`（正式站自己的 A1 一次性密碼），A1 登入改密。
>
> 部署命令、目標站選擇與部署鎖由 0-C 在 SOP 03 兩站版寫；本頁不寫 Compose／Caddy 命令。正式開放（真實名單匯入、校方條件）仍依正式 Gate。#197／D-09 的清庫預演前提消失，新範圍待主控台／Roy。下方原程序整段保留為歷史，不再執行。

> 執行狀態：**NOT_RUN**（2026-09-12 只寫文件，未在任何環境執行）。VM 事實為 2026-09-11 快照，執行前重新核對。規則來源：[共用契約 05](<../contracts/05 CI-CD、部署與維運.md>)。v2（2026-09-12）：清除範圍逐項列出（回覆 R16）；S14 只預演不切換。

| 欄位 | 內容 |
|---|---|
| 操作者 | Roy 確認；Fable 操作 |
| 前置 | 正式 Gate G1–G8 除本程序外已通過；校方真實名單、正式網域／OAuth 設定就緒；最終備份完成 |
| 停止條件 | 任一 Gate 未通過；清庫前備份失敗 |
| 恢復 | 清庫前備份可還原（SOP 04）；切換失敗回 staging 資料（還原備份） |
| 證據 | Roy 放行紀錄、清庫前備份物件、seed 輸出、真實名單匯入預覽、煙霧結果 |

## 步驟與預期

1. Roy 書面放行（Vault 記錄日期與版本）。
2. 停 app／worker；執行最終備份並確認 R2 物件存在。
3. `docker compose run --rm migrate pnpm db:reset --confirm=<日期>`（owner 連線；app 角色無 DELETE／TRUNCATE 權）：依契約 05 §9 逐項清除並輸出每表刪除統計：

   | 對象 | 處置 |
   |---|---|
   | Better Auth `users／accounts／sessions／verifications` | 刪除（含 A1）；A1 於步驟 4 以 `seed:a1` 重建並強制改密 |
   | `role_assignments`、`user_profiles`、申請與名單、`student_identities`、`proposal_occupancy` | 刪除 |
   | 業務表（屆別、階段、活動、組別、指派、合作案、項目、名單、回答、評分、簽核、精選、授權、核閱） | 刪除 |
   | `operation_records`、`domain_events`、`event_projections`、`due_work`、`notifications`、`digest_events`、`audit_events`、`business_clock_overrides` | 刪除（切換前的最終備份已保存整份 staging） |
   | `stored_files`、`file_references` 與 `files/`、`tmp/` | 刪除實體檔與列 |
   | schema、`schema_meta`、DB 角色、`backup_runs`、`restore_drills`、`storage_stats` | 保留 |

   reset 腳本必須拒絕在 `BUSINESS_CLOCK_OVERRIDE_ENABLED=false` 以外的環境變數組合下被誤當 staging 使用（`--confirm` 需等於當日）。
4. `migrate`；`seed:a1`（只 A1）。
5. `.env` 設 `BUSINESS_CLOCK_OVERRIDE_ENABLED=false`、正式網域與 OAuth redirect；Caddy 網域更新；核對模擬鐘頁在正式回 404（COH-10 的正式面）。
6. 啟動 app／worker；A1 登入改密；匯入真實名單（預覽→確認）；建立正式屆別。
7. 煙霧：登入、發布一則測試公告後撤回、health。
8. 記錄切換版本與時間；更新 📍 目前進度與正式 Gate 表。

**S14 預演**：在 staging 的隔離副本（SOP 04「隔離副本」）上執行步驟 2–7，不切換真正 staging；證據為刪除統計輸出與煙霧結果。

## 執行紀錄

| 日期 | 操作者 | 版本／環境 | 結果 | 證據 |
|---|---|---|---|---|
| — | — | — | NOT_RUN | — |
