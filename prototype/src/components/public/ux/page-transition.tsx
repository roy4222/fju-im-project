"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/** 換頁時內容淡入＋上移 8px（220ms）。以 pathname 為 key 重新掛載觸發動畫；reduced-motion 時只淡入。 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="page-enter">
      {children}
    </div>
  );
}
