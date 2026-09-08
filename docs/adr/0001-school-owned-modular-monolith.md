> 2026-09-07 文件鏡像。編輯來源：[Vault 正文](</Users/lubaiyu/Documents/roy422的人生online/專案/🌐 網站與互動/📁 輔大資管系專題網站/🧭 設計與決策/adr/0001-school-owned-modular-monolith.md>)；來源檔 SHA-256：`6afc8f9ff0e94366b0d4b580a6376eb969a75089832db6cf522cbc50bc13574c`。先更新來源，再重新同步。本文是文件，不是功能驗收。

# 校方自有環境中的單一應用

公開站、角色 Dashboard 與管理流程共享身分、組別、內容和版本資料，且核心資料與檔案需由校方掌握。8/17 主規格選擇單一 Next.js modular monolith，搭配 PostgreSQL、校內 VM 檔案 volume 及 Docker／Compose；不將 donor 另行部署為產品，也不引入微服務、Kubernetes、MinIO 或多雲。這個取捨保留單一業務與部署邊界，同時由校方承擔 VM、資料／檔案成對備份與還原責任；外部備份目的地仍待封板。

來源：[完整主規格](<../specs/product-v1.md>) §1.1、§11、§13、§20；2026-09-06 Roy 指示沿用既有規格並抽出文件。本 ADR 是追溯記錄既有決定，不代表實作、部署或校方驗收已完成。
