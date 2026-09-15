# S00-09 證據：CI 七道檢查

執行時間：2026-09-15 16:42:11 CST

## 實際 run

PR [#199](https://github.com/roy4222/fju-im-project/pull/199)，commit `3158ce69a038aa0221a18439a4030fadd5bfb16e`。七道**全綠**，每一道都有可開啟的 run URL：

| check | 結果 | run |
|---|---|---|
| `typecheck` | SUCCESS | [job](https://github.com/roy4222/fju-im-project/actions/runs/34948147077/job/104312382267) |
| `lint` | SUCCESS | [job](https://github.com/roy4222/fju-im-project/actions/runs/34948147077/job/104312382454) |
| `unit` | SUCCESS | [job](https://github.com/roy4222/fju-im-project/actions/runs/34948147077/job/104312382308) |
| `integration` | SUCCESS | [job](https://github.com/roy4222/fju-im-project/actions/runs/34948147077/job/104312382032) |
| `build` | SUCCESS | [job](https://github.com/roy4222/fju-im-project/actions/runs/34948147077/job/104312382329) |
| `e2e-smoke` | SUCCESS | [job](https://github.com/roy4222/fju-im-project/actions/runs/34948147077/job/104312382409) |
| `audit` | SUCCESS | [job](https://github.com/roy4222/fju-im-project/actions/runs/34948147077/job/104312382246) |

## 各道跑什麼（契約 05 §2）

| job | 內容 |
|---|---|
| `typecheck` | `tsc --noEmit` |
| `lint` | `eslint` ＋ `lint:boundaries-test`（七反例三合法例） |
| `unit` | 不需要資料庫的單元測試 |
| `integration` | postgres 16.10 service：空庫 migration、`fju_app` 逐表權限拒絕、harness 自測、health、Compose 定義、deploy 設定 |
| `build` | `next build` ＋ 實際 `docker build` 映像（S00 只 build，不推 GHCR） |
| `e2e-smoke` | 跑 migration、設 CI 的 `fju_app` 密碼、起 app、等 health 綠，再跑 Playwright |
| `audit` | `pnpm audit` → `web/scripts/audit-check.mjs`：只擋會進到 `web/` 的 high 以上 |

## 順帶清掉的漏洞

建 audit 那一道時發現 `web/` 有 13 件 high 以上，已處理到 **0**：

- `@better-auth/cli` 移出 devDependencies，改由 `auth-generate` 以 `pnpm dlx` 釘版隔離執行（它會拉進 prisma 與一票有洞的舊套件，而它只是產 schema 的一次性工具）；產物與裝成 devDependency 時逐字相同。
- `next` 16.3.1 → 16.3.3（修 2 個 critical）、`vitest` 3.2.4 → 3.2.6（修 1 個 critical）。
- `pnpm-workspace.yaml` 加 `overrides: js-yaml ^4.3.2`（eslint 鏈上的 high）。

`prototype/` 仍有 2 個 critical（`next@16.3.1`）與 5 個 high。原型正在 Cloudflare 展示中，本批依指示沒有動它；audit 腳本明確把「只影響 prototype 的」列出來但不擋。**建議另開一張票升版。**

## 分支保護

check 名稱已經出現，設定準備好了但**尚未套用**——見同目錄 [branch-protection.md](branch-protection.md) 與 [branch-protection.json](branch-protection.json)。

實查：`main` 的 `protected` 目前是 `false`。依契約 05 §2，在 GitHub 真的啟用前，文件一律標 **pending**，不宣稱 main 已受保護。


## 2026-09-15 合併後收尾

綠燈：[main run 34963158736](https://github.com/roy4222/fju-im-project/actions/runs/34963158736)。刻意 assertion 失敗的 [PR #200](https://github.com/roy4222/fju-im-project/pull/200) 產生 [run 34963728606](https://github.com/roy4222/fju-im-project/actions/runs/34963728606)：unit FAILURE，其餘六道 SUCCESS；PR 已關閉且未合併。負向測試不在 main。

main 的 active ruleset 23429589 現已要求七道 required checks，strict 模式。使用 `/rules/branches/main` 與 `/rulesets/23429589` 核對；舊 branch-protection REST endpoint 回 404 不代表 ruleset 不存在。上方「未套用」為當時快照。
