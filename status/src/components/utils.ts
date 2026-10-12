import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn 的 class 合併工具（Tailwind 衝突時後者勝）。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
