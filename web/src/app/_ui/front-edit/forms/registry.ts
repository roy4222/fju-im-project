import type { requestHeroUploadAction, saveHeroAction, saveSiteTextAction } from './actions'

/**
 * 延遲表單拿 Server Function 的地方（C2-17）。
 *
 * 這個檔刻意**沒有任何執行期 import**：表單模組是按下「編輯」才載的延遲 chunk，只要它靜態引用到 `./actions`
 * （Server Function 的客戶端接線 `callServer` 等），Turbopack 就會把那段接線從「每頁都載」的共用 chunk 拆成另一塊，
 * 所有路由的 gzip 都變大（AC-C2-44 步驟 7：`/` 不能比開工值大）。所以由父層 `forms.ts`（編輯層載入時就在）
 * 在模組初始化時把 actions 放進來，延遲表單只 import 這個小檔。
 */
export type FeActions = {
  readonly saveSiteText: typeof saveSiteTextAction
  readonly saveHero: typeof saveHeroAction
  readonly requestHeroUpload: typeof requestHeroUploadAction
}

let provided: FeActions | null = null

export function provideFeActions(actions: FeActions): void {
  provided = actions
}

/** 一定在編輯層載入之後才會被叫到（表單只能由 `front-edit.tsx` 經 `FE_FORMS` 載入）。 */
export function feActions(): FeActions {
  if (!provided) throw new Error('前台編輯的 Server Function 還沒登錄（forms.ts 要先載入）。')
  return provided
}
