---
status: proposed
decision_date: 2026-09-12
recorded: 2026-09-12
---
# 事件表兼 outbox、單機 worker 與到期工作表，不引入訊息系統

站內通知、彙整、截止快照、提案到期與檔案清理都需要「業務變更之後」與「時間到了之後」可靠地產生後續動作。8 GB 單機 VM 與校方接手的維運能力，不適合再加 Redis／RabbitMQ／Kafka。

2026-09-12 依 Codex 審查 E05／E08 決定：

- `domain_events` 是 insert-only 的事件表，同時是 outbox；事件在業務交易內寫入，並在寫入時固定收件人集合與依據。
- `event_projections` 記每個 consumer 的可變投影狀態；單一 `worker` 服務以 PostgreSQL advisory lock 保證只有一個活躍實例，以 `FOR UPDATE SKIP LOCKED` 認領，通知寫入與投影完成在同一交易。
- `due_work` 是時間觸發的工作表；期限變更時在同一交易寫入新版本並取消舊版本；worker 以業務鐘 tick 認領執行，服務停機後補跑，回撥不重跑已完成的工作。

代價：吞吐受單一 worker 限制（本產品規模每日事件數量級為數百）；投影延遲最多數秒；需要 SOP 處理毒事件。替代方案（每次請求同步寫通知、外部佇列）被否決：前者讓失權遮罩與補建無法一致，後者增加校方維運負擔。這是難逆轉的資料與部署形狀，因此記為 ADR；未經 review 前狀態為 proposed。

來源：[總 spec](<../ARCHITECTURE.md>) §5.4–5.5；[共用契約 01](<../engineering/contracts/01 資料模型與一致性.md>) §6、§8；[模組 08](<../engineering/modules/08 站內通知與日曆.md>)。本 ADR 不代表實作或驗收已完成。
