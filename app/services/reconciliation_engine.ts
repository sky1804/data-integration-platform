import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'
import type NormalizedShipment from '#models/normalized_shipment'
import ReconciliationRun from '#models/reconciliation_run'
import Discrepancy from '#models/discrepancy'
import type { DiscrepancyType } from '#models/discrepancy'
import {
  ReconciliationEngineError,
  ReconciliationExecutionError,
  ReconciliationFinalizationError,
} from '#services/reconciliation_engine_errors'
import type { ReconciliationFailureCode } from '#services/reconciliation_engine_errors'

export interface ReconciliationInput {
  carrierSyncRunId: number
  tmsSyncRunId: number
}

type Dataset = Map<string, NormalizedShipment>
type ResultRow = Pick<
  Discrepancy,
  'shipmentKey' | 'type' | 'carrierNormalizedShipmentId' | 'tmsNormalizedShipmentId'
>

export default class ReconciliationEngine {
  async execute({
    carrierSyncRunId,
    tmsSyncRunId,
  }: ReconciliationInput): Promise<ReconciliationRun> {
    for (const id of [carrierSyncRunId, tmsSyncRunId]) {
      if (!Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647) {
        throw new ReconciliationEngineError(
          'INVALID_SYNC_RUN_ID',
          'Sync run IDs must be positive integers'
        )
      }
    }
    if (carrierSyncRunId === tmsSyncRunId) {
      throw new ReconciliationEngineError(
        'INVALID_PROVIDER_PAIR',
        'Distinct Carrier and TMS sync runs are required'
      )
    }

    let carrier: Dataset
    let tms: Dataset
    try {
      // One consistent read snapshot. No source/raw values are modified or used
      // as business comparison fields, and no row locks are introduced.
      const datasets = await db.transaction(
        async (trx) => ({
          carrier: await this.loadDataset(carrierSyncRunId, 'carrier', trx),
          tms: await this.loadDataset(tmsSyncRunId, 'tms', trx),
        }),
        { isolationLevel: 'repeatable read' }
      )
      carrier = datasets.carrier
      tms = datasets.tms
    } catch (error) {
      if (error instanceof ReconciliationEngineError) throw error
      throw new ReconciliationEngineError(
        'PERSISTENCE_ERROR',
        'Unable to load reconciliation inputs'
      )
    }

    let run: ReconciliationRun
    try {
      run = await ReconciliationRun.create({
        carrierSyncRunId,
        tmsSyncRunId,
        status: 'PENDING',
        carrierRecords: carrier.size,
        tmsRecords: tms.size,
      })
    } catch {
      throw new ReconciliationEngineError(
        'PERSISTENCE_ERROR',
        'Unable to create a reconciliation run'
      )
    }

    try {
      try {
        run.merge({ status: 'RUNNING', startedAt: DateTime.utc() })
        await run.save()
      } catch {
        throw new ReconciliationEngineError(
          'PERSISTENCE_ERROR',
          'Unable to start the reconciliation run'
        )
      }
      const result = this.compare(carrier, tms)
      try {
        await db.transaction(async (trx) => {
          for (const row of result.rows) {
            await Discrepancy.create({ ...row, reconciliationRunId: run.id }, { client: trx })
          }
          const outcome = await ReconciliationRun.findOrFail(run.id, { client: trx })
          outcome.merge({
            status: 'SUCCESS',
            comparedRecords: result.comparedRecords,
            discrepanciesFound: result.rows.length,
            finishedAt: DateTime.utc(),
            errorCode: null,
            errorMessage: null,
          })
          await outcome.save()
        })
      } catch {
        throw new ReconciliationEngineError(
          'PERSISTENCE_ERROR',
          'Unable to persist reconciliation results'
        )
      }
    } catch (error) {
      const code: ReconciliationFailureCode =
        error instanceof ReconciliationEngineError && error.code === 'PERSISTENCE_ERROR'
          ? 'PERSISTENCE_ERROR'
          : 'UNEXPECTED_ERROR'
      const message =
        code === 'PERSISTENCE_ERROR'
          ? 'Unable to persist reconciliation results'
          : 'An unexpected reconciliation error occurred'
      try {
        run.merge({
          status: 'FAILED',
          comparedRecords: 0,
          discrepanciesFound: 0,
          finishedAt: DateTime.utc(),
          errorCode: code,
          errorMessage: message,
        })
        await run.save()
        await run.refresh()
      } catch {
        throw new ReconciliationFinalizationError(run.id)
      }
      throw new ReconciliationExecutionError(code, message, run.id)
    }

    // The SUCCESS transaction already committed. A read failure must not relabel
    // it FAILED while leaving committed discrepancies behind.
    try {
      await run.refresh()
    } catch {
      throw new ReconciliationFinalizationError(run.id)
    }
    return run
  }

  private async loadDataset(
    id: number,
    provider: 'carrier' | 'tms',
    trx: TransactionClientContract
  ): Promise<Dataset> {
    const run = await SyncRun.query({ client: trx }).where('id', id).preload('integration').first()
    if (!run)
      throw new ReconciliationEngineError(
        'SYNC_RUN_NOT_FOUND',
        'A selected sync run does not exist'
      )
    if (run.status !== 'SUCCESS')
      throw new ReconciliationEngineError(
        'SYNC_RUN_NOT_SUCCESS',
        'Reconciliation requires successful sync runs'
      )
    if (run.integration.provider !== provider)
      throw new ReconciliationEngineError(
        'INVALID_PROVIDER_PAIR',
        'Selected sync runs must have the Carrier and TMS provider roles'
      )
    const sources = await SourceRecord.query({ client: trx })
      .select('id')
      .where('syncRunId', id)
      .preload('normalizedShipment')
    if (sources.some((source) => !source.normalizedShipment))
      throw new ReconciliationEngineError(
        'INCOMPLETE_NORMALIZATION',
        'A selected sync run has incomplete canonical projections'
      )
    const records: Dataset = new Map()
    for (const source of sources) {
      const record = source.normalizedShipment
      if (records.has(record.shipmentKey))
        throw new ReconciliationEngineError(
          'DUPLICATE_SHIPMENT_KEY',
          'A selected sync run has duplicate canonical shipment keys'
        )
      records.set(record.shipmentKey, record)
    }
    return records
  }

  private compare(carrier: Dataset, tms: Dataset) {
    const rows: ResultRow[] = []
    let comparedRecords = 0
    const keys = [...new Set([...carrier.keys(), ...tms.keys()])].sort()
    for (const shipmentKey of keys) {
      const carrierRow = carrier.get(shipmentKey)
      const tmsRow = tms.get(shipmentKey)
      const add = (type: DiscrepancyType) =>
        rows.push({
          shipmentKey,
          type,
          carrierNormalizedShipmentId: carrierRow?.id ?? null,
          tmsNormalizedShipmentId: tmsRow?.id ?? null,
        })
      if (!carrierRow) {
        add('MISSING_IN_CARRIER')
        continue
      }
      if (!tmsRow) {
        add('MISSING_IN_TMS')
        continue
      }
      comparedRecords++
      if (carrierRow.status !== tmsRow.status) add('STATUS_MISMATCH')
      if (carrierRow.amount !== tmsRow.amount) add('VALUE_MISMATCH')
    }
    return { rows, comparedRecords }
  }
}
