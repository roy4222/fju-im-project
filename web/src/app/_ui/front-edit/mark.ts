import 'server-only'
import { headers } from 'next/headers'
import { cache } from 'react'
import type { ResolvedActor } from '@/application/accounts'
import { renderActor } from '@/app/_ui/guard'
import { actorHasRole, checkStatus } from '@/composition/accounts'
import { OFFICE_REWRITE_HEADER } from '@/proxy'
import type { FeFields, FeKind } from './forms'

/**
 * 前台編輯模式的 `data-fe-*` 標記（C2-16；規格② 設計方案 §6.2 第 1 點、§6.3、§6.3.1）。
 *
 * 前台頁照常是 server 元件，只在「經 proxy 改寫進編輯路由、而且是已開通的系辦」時，既有元素多這幾個屬性；
 * 其他人（訪客、學生、老師，以及直接打公開網址的系辦以外的人）拿到空物件，HTML 一個位元組都不多。
 * 編輯層（`front-edit.tsx`）只讀這些屬性，不知道頁面長怎樣。
 *
 * 用法：頁面 `const fe = await frontEditScope()`，再把 `{...feSection(fe, …)}`／`{...feItem(fe, …)}` 展開到既有元素上。
 */

/** 這次 render 是不是要標記。`null` 就是不標（所有 `fe*` 都回空物件）。 */
export type FrontEditScope = { readonly office: true } | null

/** 已開通的系辦（§6.1）：有效的 admin 角色＋過得了 business 狀態閘門。 */
export function isFrontEditor(actor: ResolvedActor): boolean {
  return actorHasRole(actor, 'admin') && checkStatus(actor, 'business') === null
}

/**
 * 同一次 render 只判一次。先看改寫標頭（訪客沒有，不多解析身分），再看是不是系辦。
 * 標頭只有 `proxy.ts` 改寫時會加（用戶端送的同名標頭在那裡被刪掉），所以公開網址的直接渲染永遠不標。
 */
export const frontEditScope = cache(async (): Promise<FrontEditScope> => {
  if ((await headers()).get(OFFICE_REWRITE_HEADER) !== '1') return null
  return isFrontEditor(await renderActor()) ? { office: true } : null
})

type Marks = Record<`data-fe-${string}`, string>

/**
 * 可改的區塊：編輯模式下畫虛線框＋左上角標籤。
 * - `label`：標籤上的區塊名（「最新公告」）。
 * - `add`：有才出現「＋新增」，開這個 kind 的新增表單。
 * - `cohort`：新增時的屆別來源（`FeFormProps.cohortId`）；沒有就由表單取預設工作屆別。
 */
export function feSection(scope: FrontEditScope, section: { label: string; add?: FeKind; cohort?: string | null }): Marks {
  if (!scope) return {}
  const marks: Marks = { 'data-fe-section': section.label }
  if (section.add) marks['data-fe-add'] = section.add
  if (section.cohort) marks['data-fe-cohort'] = section.cohort
  return marks
}

/**
 * 可改的一則：編輯模式下右上角出現「編輯」（與「刪除」）。
 * - `fields`：表單預填用的純值（JSON 放進 `data-fe-fields`）；`title` 也是刪除確認框「確定刪除『…』？」用的名稱。
 * - `rev`：目前的 revision（`data-fe-rev`）；不知道就不給，表單自己重讀。
 * - `del`：`true`＝可刪；字串＝不能刪，按鈕 disabled 並寫這句原因；不給＝只能改不能刪（按鈕不出現）。
 */
export function feItem(
  scope: FrontEditScope,
  item: { kind: FeKind; id: string; rev?: number | null; fields?: FeFields; del?: true | string },
): Marks {
  if (!scope) return {}
  const marks: Marks = { 'data-fe-item': item.kind, 'data-fe-id': item.id }
  if (item.rev !== undefined && item.rev !== null) marks['data-fe-rev'] = String(item.rev)
  if (item.fields) marks['data-fe-fields'] = JSON.stringify(item.fields)
  if (item.del === true) marks['data-fe-del'] = '1'
  else if (typeof item.del === 'string') {
    marks['data-fe-del'] = '0'
    marks['data-fe-del-reason'] = item.del
  }
  return marks
}
