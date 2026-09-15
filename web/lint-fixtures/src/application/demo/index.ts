// 模組的公開入口。infrastructure 實作 port 時從這裡拿東西。
// 只能接自己模組內部的東西——接別的模組的私有檔案一樣會被 fju/module-boundary 擋。
export { parseDemoId } from './valid-application-uses-domain'
