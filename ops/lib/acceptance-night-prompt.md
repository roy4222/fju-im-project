## 最後一則訊息＝報告（只輸出 Markdown，不要多寫別的）
- 報告格式照 <checklist> 裡自己的「報告格式」一節逐字寫（表頭六行、問題清單九欄、最後的「總結：」行；劇本章另有「交給下一章的狀態」表與「接力：」行）。
- 每做完一步，先在目前目錄的 progress.md append 一行（`| 步驟 | 結果 | HH:MM | screenshots/NN-xxx.png |`），再做下一步；逾時被停掉時只剩這個檔。
- 整夜密碼在環境變數 ACCEPT_PASSWORD：填表時讓 shell 展開，例如 `"$PWCLI" fill <ref> "$ACCEPT_PASSWORD"`；和 E2E 管理員帳密一樣，不得印出、不得寫進任何檔案或報告。
- 這一項的 id 在環境變數 ACCEPT_ITEM。瀏覽器工作階段名一律 `${ACCEPT_ITEM}-<角色>`；登入狀態用 state-save 存到 `$ACCEPT_STATE_DIR/${ACCEPT_ITEM}-<角色>.json`。
