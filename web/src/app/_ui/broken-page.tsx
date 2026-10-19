import './broken-page.css'
import { BROKEN_GRADIENT, FuzzyText, GlitchLink } from '@/app/_ui/fx/fuzzy-text'
import { SiteShell } from '@/app/_ui/site-shell'

/**
 * 404／403 共用的「壞掉」頁（規格④ §6）：頂列、頁尾照舊，只有 `main` 整塊深藍、上緣一條輔大三色線；
 * 「404」、標題、說明三段抖動三色字（`FuzzyText`），按鈕偶爾跟著抖（`GlitchLink`）。
 * 兩頁的三段文字完全相同（沒權限就不要出現，Q35）；只差按鈕：404「回首頁」、403「回到自己的首頁」。
 * 真文字（`h1`／`p`）一定在 DOM、不依量測，所以同一角色不同拒絕原因的 `main` 文字相同（deny-not-found.spec）。
 * `staticFooter` 照傳給 `SiteShell`：根層 not-found 不讀 `site_texts`（C2-17）。
 */
export async function BrokenPage({
  action,
  staticFooter = false,
}: {
  action: { href: string; label: string }
  staticFooter?: boolean
}) {
  return (
    <SiteShell bare staticFooter={staticFooter}>
      <div className="broken-page" data-testid="not-found">
        <div className="broken-stripe" data-testid="broken-stripe" data-gradient={BROKEN_GRADIENT} aria-hidden="true" />
        <div className="broken-body">
          <FuzzyText as="span" intensity={0.35} className="broken-code">
            404
          </FuzzyText>
          <FuzzyText as="h1" intensity={0.2} className="broken-title">
            找不到這個頁面
          </FuzzyText>
          <FuzzyText as="p" intensity={0.2} maxShift={1} fps={20} className="broken-desc">
            網址可能打錯了，或這個內容已經下架。
          </FuzzyText>
          <div className="broken-actions">
            <GlitchLink href={action.href} className="btn-fju h-11.5 px-7 text-[15px]">
              {action.label}
            </GlitchLink>
          </div>
        </div>
      </div>
    </SiteShell>
  )
}
