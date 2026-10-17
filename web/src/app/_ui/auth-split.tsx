import type { ReactNode } from 'react'

/**
 * 登入、註冊共用的左圖右卡外框（N3，從原型 `auth-split.tsx` 搬來）。
 * ≥1024px：左邊校園照片、右邊卡片；<1024px 只顯示卡片，不顯示照片。
 * 用原生 `<img>`：專案沒開 image optimizer，也不想多帶 client JS。
 * `loading="lazy"`：不然 React 伺服器渲染會自動插 `<link rel="preload">`，手機看不到圖也照樣下載；
 * 桌機圖就在畫面內，lazy 也會馬上載。高度扣掉 80px 的站台導覽列。
 */
export function AuthSplit({
  image,
  children,
}: {
  image: { src: string; alt: string; width: number; height: number }
  children?: ReactNode
}) {
  return (
    <div className="flex min-h-[calc(100dvh-5rem)] flex-col bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_560px]">
      <aside className="hidden lg:block relative overflow-hidden bg-primary">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.src}
          alt={image.alt}
          width={image.width}
          height={image.height}
          loading="lazy"
          className="absolute inset-0 size-full object-cover"
        />
      </aside>
      <div className="flex flex-1 justify-center px-5 pt-7 pb-14 sm:px-8 sm:pt-10 lg:items-center lg:px-12 lg:py-16">
        <div className="w-full max-w-[440px]">{children}</div>
      </div>
    </div>
  )
}
