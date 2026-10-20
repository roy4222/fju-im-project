'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { IconBook2, IconPlus } from '@tabler/icons-react'
import { Panel } from '@/app/_ui/dashboard-kit'
import { InlineRuleForm, RuleCard, type InlineDone, type RuleCardFacts } from '@/app/dashboard/admin/affairs/_content/rules-card'
import { moveRuleAction } from '@/app/dashboard/admin/affairs/actions'
import { DIALOG, PRIMARY, SECONDARY } from '@/app/dashboard/admin/affairs/item-form-parts'
import { reorderRulesAction } from '@/app/dashboard/admin/affairs/rules-actions'
import { cn } from '@/shared/cn'

/**
 * 專題規則一頁編輯的互動部分（C 階段規格① §4.4、C1-08）。
 *
 * - 拖曳排序：原生 HTML5 `dragstart`／`drop`；放下那一刻畫面先換成新順序，再送整串（`reorderRulesAction`）、`router.refresh()`；
 *   伺服器擋下（例如別人剛新增或刪了一章）就換回原順序並寫原因。
 * - 上移／下移保留（鍵盤與手機用；`moveRuleAction`），回饋句寫在卡片頂端（`pin-feedback`，跟舊清單同一個位置）。
 * - 「編輯」在卡片內就地展開，一次只展開一章；前一章有未存的改動時先問一句「要放棄嗎」。
 * - 「新增章節」在清單底部加一張展開的空卡（同一張表單，新增一章）。
 */

type Feedback = { ok: boolean; text: string }
const NEW = 'new'

/** 把 `from` 移到 `to` 原本的位置（往下拖放在它後面、往上拖放在它前面）。 */
function moveTo(ids: readonly string[], from: string, to: string): string[] {
  const start = ids.indexOf(from)
  const end = ids.indexOf(to)
  if (start < 0 || end < 0 || start === end) return [...ids]
  const next = ids.filter((id) => id !== from)
  next.splice(end, 0, from)
  return next
}

export function RulesBoard({ cohortId, cards }: { cohortId: string; cards: readonly RuleCardFacts[] }) {
  const router = useRouter()
  const [order, setOrder] = useState<readonly RuleCardFacts[]>(cards)
  const [synced, setSynced] = useState(cards)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [asking, setAsking] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const confirmDialog = useRef<HTMLDialogElement>(null)

  // 伺服器重抓（`router.refresh()`）帶來新的卡片時換成伺服器的順序。
  if (cards !== synced) {
    setSynced(cards)
    setOrder(cards)
  }

  useEffect(() => {
    const dialog = confirmDialog.current
    if (!dialog) return
    if (asking && !dialog.open) dialog.showModal()
    if (!asking && dialog.open) dialog.close()
  }, [asking])

  function open(target: string | null) {
    setExpanded(target)
    setDirty(false)
    setAsking(null)
  }

  /** 換展開的那一章：前一章有未存改動就先問。 */
  function requestOpen(target: string) {
    if (expanded !== null && expanded !== target && dirty) setAsking(target)
    else open(target)
  }

  function done(result: InlineDone) {
    open(null)
    setFeedback({ ok: true, text: result.message ?? (result.status === 'published' ? '已發布' : '已儲存') })
    router.refresh()
  }

  async function move(card: RuleCardFacts, direction: 'up' | 'down') {
    setBusy(true)
    setFeedback(null)
    try {
      // 上下移每按一次就是一次新的移動，所以每按一次用新的請求編號。
      const result = await moveRuleAction(card.id, direction, crypto.randomUUID())
      setFeedback({ ok: result.ok, text: result.ok ? (result.message ?? '已完成。') : result.message })
      if (result.ok) router.refresh()
    } catch {
      setFeedback({ ok: false, text: '連線中斷；結果尚未確認，請重新整理頁面看順序再決定要不要再按一次。' })
    } finally {
      setBusy(false)
    }
  }

  async function drop(from: string, to: string) {
    const before = order
    const ids = moveTo(
      before.map((c) => c.id),
      from,
      to,
    )
    if (ids.every((id, i) => id === before[i]?.id)) return
    const byId = new Map(before.map((c) => [c.id, c] as const))
    setOrder(ids.map((id) => byId.get(id)!))
    setBusy(true)
    setFeedback(null)
    try {
      const result = await reorderRulesAction(cohortId, ids, crypto.randomUUID())
      setFeedback({ ok: result.ok, text: result.message })
      if (result.ok) router.refresh()
      else setOrder(before)
    } catch {
      setOrder(before)
      setFeedback({ ok: false, text: '連線中斷；結果尚未確認，請重新整理頁面看順序再決定要不要再拖一次。' })
    } finally {
      setBusy(false)
    }
  }

  const form = (itemId: string | null) => (
    <InlineRuleForm
      cohortId={cohortId}
      itemId={itemId}
      onDirty={() => setDirty(true)}
      onDone={done}
      onCancel={() => open(null)}
    />
  )
  const askingTitle = expanded === NEW ? '新的章節' : `「${order.find((c) => c.id === expanded)?.title ?? ''}」`

  return (
    <Panel title="章節" icon={<IconBook2 />} description={`共 ${order.length} 節・拖曳或用上移、下移調整順序`}>
      {feedback ? (
        <p
          role="status"
          data-testid="pin-feedback"
          className={cn(
            'border-t border-border px-5 py-2.5 text-sm font-semibold',
            feedback.ok ? 'bg-success-subtle text-success-on-subtle' : 'bg-destructive-subtle text-destructive-on-subtle',
          )}
        >
          {feedback.text}
        </p>
      ) : null}
      <ol className="border-t border-border" aria-label="專題規則章節" data-testid="rules-board">
        {order.map((card, index) => (
          <RuleCard
            key={card.id}
            card={card}
            index={index}
            total={order.length}
            busy={busy}
            expanded={expanded === card.id}
            dragging={dragId === card.id}
            dropTarget={overId === card.id && dragId !== null && dragId !== card.id}
            onMove={(direction) => move(card, direction)}
            onEdit={() => requestOpen(card.id)}
            onDeleted={(text) => {
              if (expanded === card.id) open(null)
              setFeedback({ ok: true, text })
              router.refresh()
            }}
            dragHandlers={{
              onDragStart: (e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', card.id)
                setDragId(card.id)
              },
              onDragEnd: () => {
                setDragId(null)
                setOverId(null)
              },
              onDragOver: (e) => {
                if (dragId === null) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (overId !== card.id) setOverId(card.id)
              },
              onDragLeave: () => {
                if (overId === card.id) setOverId(null)
              },
              onDrop: (e) => {
                e.preventDefault()
                const from = dragId ?? e.dataTransfer.getData('text/plain')
                setDragId(null)
                setOverId(null)
                if (from) void drop(from, card.id)
              },
            }}
          >
            {form(card.id)}
          </RuleCard>
        ))}
        {expanded === NEW ? (
          <li className="border-t border-border bg-muted/30 px-4 pt-4 pb-3" data-testid="rule-new-card">
            <p className="mb-3 text-sm font-bold">新增章節</p>
            {form(null)}
          </li>
        ) : null}
      </ol>
      {order.length === 0 && expanded !== NEW ? (
        <p className="border-t border-border px-4 py-10 text-center text-sm font-semibold">這一屆還沒有專題規則。按「新增章節」建立第一章。</p>
      ) : null}
      {expanded !== NEW ? (
        <div className="border-t border-border px-4 py-3">
          <button type="button" className={cn(PRIMARY, 'h-9')} disabled={busy} onClick={() => requestOpen(NEW)}>
            <IconPlus aria-hidden /> 新增章節
          </button>
        </div>
      ) : null}
      <dialog
        ref={confirmDialog}
        aria-label="放棄未儲存的修改？"
        className={cn(DIALOG, 'w-[min(28rem,calc(100vw-2rem))]')}
        onCancel={(e) => {
          e.preventDefault()
          setAsking(null)
        }}
      >
        {asking ? (
          <div className="flex flex-col gap-4 px-6 py-5">
            <p className="text-base font-bold break-words">{askingTitle}還有沒儲存的修改，要放棄嗎？</p>
            <div className="flex justify-end gap-2">
              <button type="button" className={SECONDARY} onClick={() => setAsking(null)}>
                繼續編輯
              </button>
              <button type="button" className={cn(PRIMARY, 'bg-destructive hover:bg-destructive/90')} onClick={() => open(asking)}>
                放棄修改
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </Panel>
  )
}
