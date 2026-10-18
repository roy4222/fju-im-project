'use client'

import type { ComponentProps } from 'react'
import { trackEvent } from './track'

/**
 * 作品頁的影片 iframe（B 設計方案 §7.3.1）：iframe 載入完成送 `video_play`。
 * 只換掉 `<iframe>` 標籤本身，屬性原樣傳下去；事件不帶作品 ID 或影片 ID。
 */
export function VideoPlay(props: ComponentProps<'iframe'>) {
  return (
    <iframe
      {...props}
      onLoad={(event) => {
        props.onLoad?.(event)
        trackEvent('video_play')
      }}
    />
  )
}
