// vitest 在 Node 裡跑，沒有 React 的 server/client 條件解析，所以把 `server-only`
// 換成空模組。正式 build 仍然解析到真正的 server-only（違規會在 build 時爆）。
export {}
