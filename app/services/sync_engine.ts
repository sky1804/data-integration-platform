import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import Integration from '#models/integration'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'
import type { Connector } from '../integrations/connector.js'
import { ConnectorError, type ConnectorFailureKind } from '../integrations/connector_errors.js'
import {
  createConnector,
  isSupportedProvider,
  type SupportedProvider,
} from '../integrations/connector_factory.js'
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
    return { code: 'PAGINATION_CYCLE', message: 'Provider returned a previously requested cursor' }
  }
  if (error instanceof ConnectorError) {
    const failures: Record<ConnectorFailureKind, { code: SyncFailureCode; message: string }> = {
      AUTHENTICATION: {
        code: 'PROVIDER_AUTHENTICATION',
        message: 'Provider authentication failed',
      },
      RATE_LIMIT: { code: 'PROVIDER_RATE_LIMIT', message: 'Provider rate limit exceeded' },
      UNAVAILABLE: { code: 'PROVIDER_UNAVAILABLE', message: 'Provider is unavailable' },
      TIMEOUT: { code: 'PROVIDER_TIMEOUT', message: 'Provider request timed out' },
      PAYLOAD_INVALID: {
        code: 'PROVIDER_PAYLOAD_INVALID',
        message: 'Provider returned an invalid payload',
      },
      REQUEST_FAILED: {
        code: 'PROVIDER_REQUEST_FAILED',
        message: 'Provider returned an unexpected response',
      },
    }
    return failures[error.kind]
  }
  return { code: 'UNEXPECTED_ERROR', message: 'An unexpected synchronization error occurred' }
}

export default class SyncEngine {
  private readonly connectorResolver: (provider: SupportedProvider) => Connector
  private readonly pageSize: number

  constructor({
    connectorResolver = createConnector,
    pageSize = 100,
  }: {
    connectorResolver?: (provider: SupportedProvider) => Connector
    pageSize?: number
  } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new TypeError('Synchronization page size must be an integer between 1 and 100')
    }
    this.connectorResolver = connectorResolver
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
    if (!isSupportedProvider(integration.provider)) {
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
      const connector = this.connectorResolver(integration.provider)
      let cursor: string | undefined
      const requestedCursors = new Set<string>()
      while (true) {
        if (cursor !== undefined) {
          if (requestedCursors.has(cursor)) {
            throw new SyncEngineError('PAGINATION_CYCLE', 'Provider cursor cycle detected')
          }
          requestedCursors.add(cursor)
        }
        // HTTP work stays outside database transactions and inside the connector/client boundary.
        const page = await connector.fetchPage({ cursor, limit: this.pageSize })
        run.recordsReceived += page.records.length
        try {
          await db.transaction(async (trx) => {
            for (const record of page.records) {
              await SourceRecord.create(
                {
                  syncRunId: run.id,
                  externalId: record.externalId,
                  payload: record.payload,
                  sourceUpdatedAt: record.sourceUpdatedAt,
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
          throw new SyncEngineError('PERSISTENCE_ERROR', 'Unable to persist the provider page')
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
