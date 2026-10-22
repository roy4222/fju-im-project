import 'server-only'
import type { ReactNode } from 'react'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { renderActor } from '@/app/_ui/guard'
import { FrontEdit } from '@/app/_ui/front-edit/front-edit'
import { isFrontEditor } from '@/app/_ui/front-edit/mark'
import { OFFICE_REWRITE_HEADER } from '@/proxy'

/**
 * `/office-edit/*` 共用的外層（C2-16；規格② 設計方案 §6.2 第 2、4、5 點）。
 *
 * 這組路由只是「原頁元件＋`<FrontEdit/>`」，編輯層的 client 程式只進這組路由的模組圖。
 * - 沒有經過 `proxy.ts` 改寫（看不到 `x-fju-office-rewrite`）＝有人直接打 `/office-edit/*`：307 回公開路徑（帶原本的查詢字串），
 *   同一頁不留兩個網址；系辦被導回去之後 proxy 會再改寫進來。
 * - 改寫進來了但不是已開通的系辦（例如撤了管理員還沒登出，cookie 只是提示）：只回原頁、不掛編輯層——
 *   多下載一支 chunk，畫面零差異；原頁的 `data-fe-*` 也由 `frontEditScope()` 同一個判斷擋掉。
 */
export async function withFrontEdit(publicPath: string, searchParams: Promise<Record<string, string | string[] | undefined>> | undefined, page: ReactNode) {
  if ((await headers()).get(OFFICE_REWRITE_HEADER) !== '1') {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries((await searchParams) ?? {})) {
      for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v)
    }
    const qs = query.toString()
    redirect(qs ? `${publicPath}?${qs}` : publicPath)
  }
  const office = isFrontEditor(await renderActor())
  return (
    <>
      {page}
      {office ? <FrontEdit /> : null}
    </>
  )
}
