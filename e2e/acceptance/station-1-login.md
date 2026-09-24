# 第 1 站：登入、進後台、登出

- 前提：測試站已部署，而且 Doppler stg 有 `E2E_ADMIN_EMAIL`、`E2E_ADMIN_PASSWORD`（部署時自動建好 E2E 管理員）。
- 帳號：E2E 管理員（帳密在環境變數，不要寫在這裡）。
- 開始前：用全新的瀏覽器工作階段（沒有任何 cookie）。

## 步驟

1. **打開登入頁**
   - 做：打開 `https://test.fju.roy422.dev/login`。
   - 預期：看到標題「登入」、Email 欄、密碼欄、「登入」按鈕。
2. **用 E2E 管理員登入**
   - 做：Email 填 E2E 管理員的 email、密碼填 E2E 管理員的密碼，按「登入」。
   - 預期：離開登入頁，沒有被帶去改密碼頁（網址不是 `/account/change-password`）。
3. **進到後台**
   - 做：打開 `https://test.fju.roy422.dev/dashboard/admin`。
   - 預期：看到頁面標題「系辦首頁」；側邊有「我的帳號」與「登出」。
4. **登出**
   - 做：按側邊的「登出」。
   - 預期：回到登入頁或首頁；再打開 `https://test.fju.roy422.dev/dashboard/admin` 會被帶去登入頁，看不到「系辦首頁」。
5. **再登入一次**
   - 做：在登入頁用 E2E 管理員的 email 與密碼再登入一次，然後打開 `https://test.fju.roy422.dev/dashboard/admin`。
   - 預期：看到「系辦首頁」。
6. **登出，準備測錯誤密碼**
   - 做：按「登出」。
   - 預期：回到登入頁或首頁。
7. **錯誤密碼登不進去**
   - 做：打開 `https://test.fju.roy422.dev/login`，Email 填 E2E 管理員的 email，密碼填一個明顯錯的字串（例如 `wrong-password-123`），按「登入」。
   - 預期：仍停在登入頁，畫面上有錯誤訊息；打開 `https://test.fju.roy422.dev/dashboard/admin` 會被帶去登入頁。

## 失敗時

- 第 2 步不通過（登不進去）：後面都做不了，記下畫面上的訊息後停止。
- 其他步驟不通過：記下來，繼續下一步。
- 第 7 步只試**一次**錯誤密碼就好，不要連續試（登入有限速，連錯太多次會讓 E2E 管理員暫時登不進去）。
