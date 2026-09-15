# S00-01 證據：pnpm dev 空殼首頁

執行時間：2026-09-15 15:27:10 CST
Node：v22.23.2

## dev server 啟動輸出
```
$ next dev --port 3000
▲ Next.js 16.3.1 (Turbopack)
- Local:         http://localhost:3000
- Network:       http://169.254.179.24:3000
✓ Ready in 379ms
✓ Running next.config.ts took 23ms

 GET / 200 in 1047ms (next.js: 931ms, application-code: 116ms)
```

## HTTP 狀態
```
GET http://localhost:3000/ -> 200
```

## 渲染後的可見文字
```
輔仁大學資訊管理學系專題管理平台工程骨架空殼（S00）。業務功能從 S01 開始。
```
