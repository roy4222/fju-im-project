# lint-fixtures

S00-06 的分層 lint 反例與合法例。這裡的檔案**故意**寫成違規或合法的樣子，用來證明 lint 規則真的有效；不要把它們當成可以抄的範例，也不要修好它們。

- 目錄結構鏡射 `src/`，所以同一套 `boundaries/elements` 設定同時套用在兩邊。
- 不在 `tsconfig.json` 的 `include` 裡，`pnpm typecheck` 不會看它們。
- `pnpm lint` 不掃這個目錄；由 `pnpm lint:boundaries-test` 逐檔斷言。
- 對照表在 `web/README.md`。
