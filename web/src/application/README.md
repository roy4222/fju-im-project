# application

用例、port 介面、DTO、授權政策。每個模組一個資料夾，`index.ts` 是唯一公開入口。

可以引用：本模組 domain 與 application、`@/shared`、他模組 application／domain 公開入口（type-only）。
不可以引用：infrastructure、app、composition、Next、Drizzle、Better Auth（母 spec §4.3）。
