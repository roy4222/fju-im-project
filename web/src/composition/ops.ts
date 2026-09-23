import 'server-only'
import type { PoolClient } from 'pg'
import type { AuditWriter, OperationLedger } from '@/application/ops'
import { PgAuditWriter } from '@/infrastructure/ops/audit-writer'
import { PgOperationLedger } from '@/infrastructure/ops/operation-ledger'

/** 模組 10 的兩個共用 port（稽核、帳本）。 */
let auditWriter: AuditWriter<PoolClient> | undefined
let operationLedger: OperationLedger<PoolClient> | undefined

export function getAuditWriter(): AuditWriter<PoolClient> {
  auditWriter ??= new PgAuditWriter()
  return auditWriter
}

export function getOperationLedger(): OperationLedger<PoolClient> {
  operationLedger ??= new PgOperationLedger()
  return operationLedger
}
