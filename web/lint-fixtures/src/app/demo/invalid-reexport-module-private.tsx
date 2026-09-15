// 反例 12：re-export 也要守公開入口，不可以指到模組內部檔案。
// 預期被擋：fju/module-boundary
export { parseDemoId } from '../../application/demo/valid-application-uses-domain'
