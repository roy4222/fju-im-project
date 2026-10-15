import Image from "next/image";
import type { ReactNode } from "react";

/**
 * 註冊／登入／待審共用的左右分割外框（v3，2026-10-15 Roy Q61）。
 * 桌機：左邊校園照片（最多一行短標題）、右邊表單；手機：照片縮成表單上方的窄條。
 * 高度扣掉 80px 的站台導覽列。
 */
export function AuthSplit({
  children,
  photo = "/placeholder/campus.jpg",
  photoAlt = "輔仁大學校園",
  title = "輔仁大學資管系 專題管理平台",
  width = "max-w-[440px]",
}: {
  children: ReactNode;
  photo?: string;
  photoAlt?: string;
  title?: string;
  width?: string;
}) {
  return (
    <div className="flex min-h-[calc(100dvh-5rem)] flex-col bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_560px] xl:grid-cols-[minmax(0,1fr)_620px]">
      <aside className="relative h-28 shrink-0 overflow-hidden bg-primary sm:h-36 lg:h-auto">
        <Image src={photo} alt={photoAlt} fill sizes="(min-width: 1024px) 60vw, 100vw" className="object-cover" preload />
        <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-primary/85 via-primary/25 to-transparent" />
        <p className="absolute inset-x-5 bottom-4 text-lg leading-snug font-extrabold text-primary-foreground sm:inset-x-8 sm:text-xl lg:inset-x-12 lg:bottom-12 lg:text-[28px] lg:tracking-wide">{title}</p>
      </aside>
      <div className="flex flex-1 justify-center px-5 pt-7 pb-14 sm:px-8 sm:pt-10 lg:items-center lg:px-12 lg:py-16">
        <div className={`w-full ${width}`}>{children}</div>
      </div>
    </div>
  );
}
