# domain

純 TypeScript：實體、值物件、不變規則、領域錯誤。每個模組一個資料夾，`index.ts` 是唯一公開入口。

可以引用：本模組 domain、`@/shared`、他模組 domain 公開入口（type-only）。
不可以引用：其他層、任何框架。外部套件只有 `decimal.js`（母 spec §4.3）。
