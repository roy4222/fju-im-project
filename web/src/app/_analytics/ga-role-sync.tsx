'use client'

import { useEffect } from 'react'
import type { GaRole } from './ga-role'
import { setUserRole } from './track'

/**
 * 把伺服器這次 render 解析到的角色同步給 GA（AC-VI-68：登入後 student、登出後 guest）。
 *
 * 由 `ga-script.tsx` 渲染，排在 layout 的 `<PageView />` 之前：同一次更新裡這裡的 effect 先跑，
 * 登入導頁後的那個 `page_view` 就已經帶新角色。
 */
export function GaRoleSync({ role }: { role: GaRole }) {
  useEffect(() => {
    setUserRole(role)
  }, [role])
  return null
}
