import type { PublicShowcaseCard } from '@/application/showcase'
import { placeholderImageFor } from '@/composition/showcase'

/**
 * 作品卡的圖：有海報就走共用下載（`/api/files/<id>`，每次重驗：只有發布中目前版本的海報公開），
 * 沒有就用佔位圖（Q-SHW01 素材到位前；同一件作品永遠同一張）。
 */
export function showcaseImage(card: Pick<PublicShowcaseCard, 'id' | 'posterFileId'>): string {
  return card.posterFileId ? `/api/files/${card.posterFileId}` : placeholderImageFor(card.id)
}
