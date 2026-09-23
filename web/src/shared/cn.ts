import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * 合併 class 名稱，後面的 Tailwind 工具類會蓋掉前面同性質的那一個。
 * 元件用它接受外部傳進來的 `className` 而不會互相打架。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
