import Link from 'next/link'
import type { ReactNode } from 'react'
import { IconArrowRight } from '@tabler/icons-react'
import './cards.css'

/**
 * 三角色首頁共用的卡片（SH-3；設計方案 §2.0、§2.3，原型第 3 輪的待辦卡）。
 *
 * - 沒有狀態、server／client 都能用；**不用 `style` 屬性**（正式站 CSP），顏色只靠 `data-tone`＋`cards.css`。
 * - `tone` 只有七個；每個 tone 讀 `--st-*`（SH-2 定義），還沒有時退回 `currentColor`。
 * - 角色規格決定每張卡用哪個 tone：逾期 `overdue`、快到期 `soon`、已完成 `done`、進行中 `open`、
 *   同意書 `violet`、待審／缺件 `alert`；其他 `neutral`。顏色不自己寫。
 */

export type Tone = 'overdue' | 'soon' | 'done' | 'open' | 'violet' | 'alert' | 'neutral'

/** 待辦卡：整張是一個連結；左側 4px 彩色邊、大圖示、標題、第二行說明、右上狀態膠囊。 */
export function TodoCard({
  tone,
  icon,
  title,
  meta,
  href,
  pill,
  testId,
}: {
  tone: Tone
  icon: ReactNode
  title: string
  meta?: ReactNode
  href: string
  pill?: { tone?: Tone; label: string }
  testId?: string
}) {
  return (
    <Link href={href} className="todo-card" data-tone={tone} data-testid={testId}>
      <span className="todo-card-icon" aria-hidden>
        {icon}
      </span>
      <span className="todo-card-body">
        <span className="todo-card-title">{title}</span>
        {meta ? <span className="todo-card-meta">{meta}</span> : null}
      </span>
      {pill ? <StatusPill tone={pill.tone ?? tone}>{pill.label}</StatusPill> : null}
    </Link>
  )
}

/** 狀態膠囊：淡色底＋同色字（舊的 `Pill` 保留給還沒改的頁）。 */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="status-pill" data-tone={tone}>
      {children}
    </span>
  )
}

/** 區塊標題：22px／900 標題、可選數字、右側細線、可選「查看全部」連結。 */
export function SectionHead({
  title,
  count,
  action,
  as: Heading = 'h2',
}: {
  title: string
  count?: number
  action?: { label: string; href: string }
  as?: 'h2' | 'h3'
}) {
  return (
    <div className="section-head">
      <Heading className="section-head-title">{title}</Heading>
      {count !== undefined ? (
        <span className="section-head-count" data-testid="section-count">
          {count}
        </span>
      ) : null}
      <span className="section-head-rule" aria-hidden />
      {action ? (
        <Link href={action.href} className="section-head-action">
          {action.label}
          <IconArrowRight aria-hidden />
        </Link>
      ) : null}
    </div>
  )
}
