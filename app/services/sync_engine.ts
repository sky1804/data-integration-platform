import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import Integration from '#models/integration'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'
import CarrierClient from '../integrations/carrier/carrier_client.js'
import {
  CarrierAuthenticationError,
  CarrierRateLimitError,
  CarrierUnavailableError,
  CarrierTimeoutError,
  CarrierPayloadValidationError,
  CarrierRequestError,
} from '../integrations/carrier/carrier_errors.js'
import {
  SyncEngineError,
  SyncExecutionError,
  SyncFinalizationError,
  type SyncFailureCode,
} from '#services/sync_engine_errors'

function describeFailure(error: unknown): { code: SyncFailureCode; message: string } {
  if (error instanceof SyncEngineError && error.code === 'PERSISTENCE_ERROR') {
    return {
      code: 'PERSISTENCE_ERROR',
      message: 'Unable to persist a synchronization page or state',
    }
  }
  if (error instanceof SyncEngineError && error.code === 'PAGINATION_CYCLE') {
    return { code: 'PAGINATION_CYCLE', message: 'Carrier returned a previously requested cursor' }
  }
  if (error instanceof CarrierAuthenticationError) {
    return { code: 'PROVIDER_AUTHENTICATION', message: 'Carrier authentication failed' }
  }
  if (error instanceof CarrierRateLimitError) {
    return { code: 'PROVIDER_RATE_LIMIT', message: 'Carrier rate limit exceeded' }
  }
  if (error instanceof CarrierUnavailableError) {
    return { code: 'PROVIDER_UNAVAILABLE', message: 'Carrier is unavailable' }
  }
  if (error instanceof CarrierTimeoutError) {
    return { code: 'PROVIDER_TIMEOUT', message: 'Carrier request timed out' }
  }
  if (error instanceof CarrierPayloadValidationError) {
    return { code: 'PROVIDER_PAYLOAD_INVALID', message: 'Carrier returned an invalid payload' }
  }
  if (error instanceof CarrierRequestError) {
    return { code: 'PROVIDER_REQUEST_FAILED', message: 'Carrier returned an unexpected response' }
  }
  return { code: 'UNEXPECTED_ERROR', message: 'An unexpected synchronization error occurred' }
}

export default class SyncEngine {
  private readonly carrierClient: Pick<CarrierClient, 'fetchPage'>
  private readonly pageSize: number

  constructor({
    carrierClient = new CarrierClient(),
    pageSize = 100,
  }: {
    carrierClient?: Pick<CarrierClient, 'fetchPage'>
    pageSize?: number
  } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new TypeError('Synchronization page size must be an integer between 1 and 100')
    }
    this.carrierClient = carrierClient
    this.pageSize = pageSize
  }

  async execute(integrationId: number): Promise<SyncRun> {
    let integration: Integration | null
    try {
      integration = await Integration.find(integrationId)
    } catch {
      throw new SyncEngineError('PERSISTENCE_ERROR', 'Unable to load the integration')
    }
    if (!integration)
      throw new SyncEngineError('INTEGRATION_NOT_FOUND', 'Integration does not exist')
    if (!integration.enabled)
      throw new SyncEngineError('INTEGRATION_DISABLED', 'Integration is disabled')
    if (integration.provider !== 'carrier') {
      throw new SyncEngineError('UNSUPPORTED_PROVIDER', 'Integration provider is not supported')
    }

    let run: SyncRun
    try {
      run = await SyncRun.create({
        integrationId: integration.id,
        status: 'PENDING',
        recordsReceived: 0,
        recordsPersisted: 0,
        recordsFailed: 0,
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
      })
    } catch {
      throw new SyncEngineError('PERSISTENCE_ERROR', 'Unable to create a synchronization run')
    }

    try {
      try {
        run.merge({ status: 'RUNNING', startedAt: DateTime.utc() })
        await run.save()
      } catch {
        throw new SyncEngineError('PERSISTENCE_ERROR', 'Unable to start the synchronization run')
      }
      let cursor: string | undefined
      const requestedCursors = new Set<string>()
      while (true) {
        if (cursor !== undefined) {
          if (requestedCursors.has(cursor)) {
            throw new SyncEngineError('PAGINATION_CYCLE', 'Carrier cursor cycle detected')
          }
          requestedCursors.add(cursor)
        }
        // HTTP work stays outside database transactions and inside CarrierClient.
        const page = await this.carrierClient.fetchPage({ cursor, limit: this.pageSize })
        run.recordsReceived += page.records.length
        try {
          await db.transaction(async (trx) => {
            for (const record of page.records) {
              await SourceRecord.create(
                {
                  syncRunId: run.id,
                  externalId: record.shipmentId,
                  payload: { ...record },
                  sourceUpdatedAt: DateTime.fromISO(record.updatedAt, { setZone: true }),
                },
                { client: trx }
              )
            }
            // Progress and rows commit together. Do not mutate committed totals early.
            const progress = await SyncRun.findOrFail(run.id, { client: trx })
            progress.merge({
              recordsReceived: run.recordsReceived,
              recordsPersisted: run.recordsPersisted + page.records.length,
              recordsFailed: run.recordsFailed,
            })
            await progress.save()
          })
        } catch {
          run.recordsFailed += page.records.length
          throw new SyncEngineError('PERSISTENCE_ERROR', 'Unable to persist the Carrier page')
        }
        run.recordsPersisted += page.records.length
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
    } catch (error) {
      const failure = describeFailure(error)
      run.merge({
        status: run.recordsPersisted > 0 ? 'PARTIAL' : 'FAILED',
        finishedAt: DateTime.utc(),
        errorCode: failure.code,
        errorMessage: failure.message,
      })
      await this.saveOutcome(run)
      throw new SyncExecutionError(failure.code, failure.message, run.id)
    }

    run.merge({
      status: 'SUCCESS',
      finishedAt: DateTime.utc(),
      errorCode: null,
      errorMessage: null,
    })
    await this.saveOutcome(run)
    return run
  }

  private async saveOutcome(run: SyncRun): Promise<void> {
    try {
      await run.save()
      await run.refresh()
    } catch {
      // Never claim a terminal outcome was recorded when the database rejected it.
      throw new SyncFinalizationError(run.id)
    }
  }
}
