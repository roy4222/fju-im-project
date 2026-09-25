import 'server-only'
import matrix from '@/infrastructure/db/permissions/matrix.json'

/**
 * 契約 01 §5 的逐表權限矩陣（表驅動）。
 *
 * 唯一正文位置在契約 01 §5；`matrix.json` 是它的機器可讀鏡像。
 * migration 的 GRANT 由 `scripts/generate-grants.mjs` 從這裡產生，
 * `roles.integration.test.ts` 也從這裡逐格驗證允許與拒絕。
 * **新增表就在 matrix.json 補一列**——不要手寫 GRANT，也不要只在測試裡加。
 */

/** `'all'` 整列可更新；`'none'` 不給 UPDATE；陣列＝只有這幾欄可以更新。 */
export type UpdateGrant = 'all' | 'none' | readonly string[]

export type TablePermission = {
  /** 這張表由哪一支 migration 建；GRANT 也產生到那一支（S00＝0001、S01＝0002）。 */
  readonly slice: string
  readonly table: string
  readonly select: boolean
  readonly insert: boolean
  readonly update: UpdateGrant
  /**
   * 表建好之後才加、而且可更新的欄：`{ 切片: [欄...] }`（例如票 39 的 0011）。
   * `update` 陣列已經含這些欄；產生器在原切片扣掉、在新切片只補 `GRANT UPDATE (欄)`。
   */
  readonly updateAddedIn?: Readonly<Record<string, readonly string[]>>
  readonly delete: boolean
  /** 不可變表：除了不給 UPDATE／DELETE，另加 trigger 當第二層。 */
  readonly immutable: boolean
  /** worker 也用（契約 01 §5 的「worker 也用」欄；拆角色時才會用到）。 */
  readonly worker: boolean
  readonly note: string
}

export const PERMISSION_MATRIX: readonly TablePermission[] = matrix.tables as readonly TablePermission[]

export const ROLES = matrix.roles as { owner: string; app: string; backup: string }

/** `fju_backup` 唯一能寫的表（S00 還沒建，先記著）。 */
export const BACKUP_WRITES = matrix.backupWrites as readonly { table: string; insert: boolean; note: string }[]

export function permissionFor(table: string): TablePermission {
  const found = PERMISSION_MATRIX.find((row) => row.table === table)
  if (!found) throw new Error(`權限矩陣裡沒有 ${table}；新增表要在 matrix.json 補一列`)
  return found
}

/** 這張表允許 `fju_app` 更新哪些欄；`'all'` 回 null（整列）。 */
export function updatableColumns(row: TablePermission): readonly string[] | null {
  if (row.update === 'all') return null
  if (row.update === 'none') return []
  return row.update
}
