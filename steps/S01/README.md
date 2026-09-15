# steps/S01｜S01 切片的證據

本批範圍與停點見 [#201](https://github.com/roy4222/fju-im-project/issues/201) 與
[NEXT-BATCH](../../docs/NEXT-BATCH.md)：**VM 測試站上的 A1 首次登入→強制改密→管理員首頁→登出重登**。

每張票一份，記錄實際跑出來的東西——指令輸出、資料庫讀回、HTTP 回應、瀏覽器觀測。
不是計畫，也不是「應該會怎樣」。沒跑的檢查一律寫 NOT_RUN。

| 票 | 證據 |
|---|---|
| S01-01 #44 | [migration-and-permissions.md](S01-01/migration-and-permissions.md)（第二支 migration、新表權限、約束反例、系級欄位） |
| S01-02 #45 | [auth-routes-and-hooks.md](S01-02/auth-routes-and-hooks.md)（兩層攔截、兩個安裝後 gate、封鎖端點的真實回應） |
| S01-03 #46 | [actor-audit-ledger.md](S01-03/actor-audit-ledger.md)（三向測試、帳本重播、稽核雙時間、狀態矩陣） |
| S01-04 #47 | [page-skeleton.md](S01-04/page-skeleton.md)（路由、授權導向、側欄、空狀態；含一個真的授權洩漏的修正與回歸測試）＋六張截圖 |
| S01-05 #48 | 尚未開工 |

## 環境

Node v22.23.2、pnpm 11.0.9、PostgreSQL 16.10（Docker Desktop）、Next 16.3.3、macOS arm64（Apple Silicon）。

## 本機怎麼重現

```bash
nvm use 22
pnpm install --frozen-lockfile --filter @fju/web...
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d postgres
pnpm -C web typecheck
pnpm -C web lint
pnpm -C web db:grants --check
pnpm -C web test:unit
pnpm -C web test:integration
```

### 本機已知落差（不是程式問題）

`test/ops/deploy*.integration.test.ts` 在 **macOS 內建的 bash 3.2** 下會失敗：`ops/deploy.sh`
的訊息裡有 `"$HEALTH_URL（逾時 …）"` 這種「變數緊接全形字」的寫法，bash 3.2 會把全形字的
位元組也算進變數名，配上 `set -u` 就變成 `unbound variable`。

```bash
$ bash --version | head -1
GNU bash, version 3.2.57(1)-release (arm64-apple-darwin25)
$ bash -c 'X=1; echo "$X（逾時）"'
??逾時）            # bash 5（CI 的 ubuntu-latest）會印出 1（逾時）
```

CI 的 integration 那道跑在 ubuntu-latest（bash 5）上，以 **CI 的結果為準**；本機要跑這兩支
測試請用 `brew install bash` 後的 bash 5。本批沒有改 `ops/deploy.sh`。
