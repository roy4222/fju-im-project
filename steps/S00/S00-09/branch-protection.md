# main 分支保護：準備好的設定（**尚未套用**，交給 Roy）

契約 05 §2：七道都是 required checks；「分支保護規則未在 GitHub 啟用前，文件標 **pending**，不宣稱 main 已受保護」。

現況（2026-09-15 實查）：`main` 的 `protected` 是 `false`，ruleset disabled。**本批沒有代為啟用**——這是會影響整個 repo 協作方式的設定，由 Roy 決定與套用。

check 名稱已經在 PR #199 第一次跑出來，所以現在可以設了：

```
typecheck  lint  unit  integration  build  e2e-smoke  audit
```

## 套用方式（擇一）

### A. 網頁

Settings → Branches → Add branch protection rule

- Branch name pattern：`main`
- ☑ Require a pull request before merging（契約 05 §2：main 只接受 PR）
- ☑ Require status checks to pass before merging
  - ☑ Require branches to be up to date before merging
  - 逐一加入上面七個 check 名稱
- ☑ Do not allow bypassing the above settings

### B. 指令（gh 已登入 roy4222，具 admin 權限）

```bash
gh api -X PUT repos/roy4222/fju-im-project/branches/main/protection \
  --input steps/S00/S00-09/branch-protection.json
```

設定內容在同目錄的 `branch-protection.json`。

## 套用後請回報

套用後 `gh api repos/roy4222/fju-im-project/branches/main/protection --jq '.required_status_checks.contexts'` 應該列出那七個名稱；把輸出貼回 #41，文件才能把 **pending** 拿掉。
