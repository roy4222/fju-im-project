/** `merge.mjs` 的型別（給 e2e 與單元測試的 TypeScript import 用）。 */
export type OverlayKind = 'fingerprints' | 'budget' | 'sql-expect'

export interface OverlayFile {
  /** 檔名，例如 `C1-13.json`。 */
  name: string
  /** 原文（還沒解析的 JSON）。 */
  text: string
}

export interface MergeResult<T extends Record<string, unknown>> {
  merged: T
  /** 參與合併的小檔名（排序後）。 */
  files: string[]
  /** 被小檔 set／override 的鍵。 */
  changed: string[]
  /** 被小檔 delete 的鍵。 */
  deleted: string[]
}

export class OverlayError extends Error {
  readonly dir: string
  constructor(dir: string, message: string)
}

export const TICKET_RE: RegExp
export function kindOf(name: string): OverlayKind
export function overlayDirFor(baseFile: string): string
export function readOverlayFiles(dir: string): OverlayFile[]
export function mergeOverlay<T extends Record<string, unknown>>(base: T, files: OverlayFile[], kind: OverlayKind, dir?: string): MergeResult<T>
export function mergeFromDir<T extends Record<string, unknown>>(base: T, dir: string, kind: OverlayKind): MergeResult<T>
export function mergeFromBaseFile<T extends Record<string, unknown> = Record<string, unknown>>(baseFile: string, kind: OverlayKind): MergeResult<T>
export function hasOverlayFiles(baseFile: string): boolean
export function foldBaseFile<T extends Record<string, unknown> = Record<string, unknown>>(baseFile: string, kind: OverlayKind): { merged: T; removed: string[] }
export function fingerprintsLiteral(merged: Record<string, string>): string
