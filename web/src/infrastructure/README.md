# infrastructure

Drizzle schema／repository、Better Auth 設定、檔案儲存、worker、Clock 實作。檔頭一律 `import 'server-only'`。

可以引用：domain 與 application 公開入口（實作 port）、`@/shared`。
不可以引用：app、composition（母 spec §4.3）。
