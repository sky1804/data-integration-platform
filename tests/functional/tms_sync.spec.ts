import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { DateTime } from 'luxon'
import Integration from '#models/integration'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'
import SyncEngine from '#services/sync_engine'
import { SyncExecutionError } from '#services/sync_engine_errors'
import TmsClient from '../../app/integrations/tms/tms_client.js'
import TmsConnector from '../../app/integrations/tms/tms_connector.js'
import { createTmsMockServer } from '../../mocks/tms/server.js'

const first = {
  shipmentCode: 'SHP-100',
  status: 'FINALIZADO',
  totalValue: 1250.5,
  deliveryDate: '2026-10-04',
  lastModifiedAt: '2026-10-04T13:00:00Z',
}
const second = {
  shipmentCode: 'SHP-101',
  status: 'EM_TRANSITO',
  totalValue: 890,
  deliveryDate: null,
  lastModifiedAt: '2026-10-04T13:10:00Z',
}
const third = {
  shipmentCode: 'SHP-102',
  status: 'CRIADO',
  totalValue: 3500.25,
  deliveryDate: null,
  lastModifiedAt: '2026-10-04T13:20:00Z',
}

async function failedOutcome(execute: () => Promise<SyncRun>) {
  try {
    await execute()
  } catch (error) {
    if (error instanceof SyncExecutionError) return SyncRun.findOrFail(error.runId)
    throw error
  }
  throw new Error('Expected a failed synchronization')
}

test.group('M5 TMS synchronization through Connector', (group) => {
  let server: ReturnType<typeof createTmsMockServer>
  let providerUrl: string
  group.each.setup(() => testUtils.db().truncate())

  group.each.setup(async () => {
    server = createTmsMockServer({ apiKey: 'tms-sync-test' })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    providerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return async () => {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    }
  })

  test('persists three exact raw TMS observations across two HTTP pages', async ({ assert }) => {
    const configured = await Integration.create({ name: 'TMS', slug: 'tms', provider: 'tms' })
    let requests = 0
    server.on('request', () => requests++)
    const connector = new TmsConnector(
      new TmsClient({ url: providerUrl, apiKey: 'tms-sync-test', timeoutMs: 1000 })
    )
    const run = await new SyncEngine({ connectorResolver: () => connector, pageSize: 2 }).execute(
      configured.id
    )
    assert.equal(run.status, 'SUCCESS')
    assert.equal(run.recordsReceived, 3)
    assert.equal(run.recordsPersisted, 3)
    assert.equal(run.recordsFailed, 0)
    assert.isNotNull(run.startedAt)
    assert.isNotNull(run.finishedAt)
    assert.isNull(run.errorCode)
    const records = await SourceRecord.query().where('syncRunId', run.id).orderBy('id')
    assert.deepEqual(
      records.map((record) => record.externalId),
      ['SHP-100', 'SHP-101', 'SHP-102']
    )
    assert.deepEqual(
      records.map((record) => record.payload),
      [first, second, third]
    )
    assert.equal(
      records[0].sourceUpdatedAt!.toMillis(),
      DateTime.fromISO(first.lastModifiedAt).toMillis()
    )
    assert.notProperty(records[0].payload, 'amount')
    assert.equal(requests, 2)
  })

  test('finalizes first-page TMS authentication failure', async ({ assert }) => {
    const configured = await Integration.create({ name: 'TMS', slug: 'tms', provider: 'tms' })
    const connector = new TmsConnector(
      new TmsClient({ url: providerUrl, apiKey: 'wrong', timeoutMs: 1000 })
    )
    const run = await failedOutcome(() =>
      new SyncEngine({ connectorResolver: () => connector }).execute(configured.id)
    )
    assert.equal(run.status, 'FAILED')
    assert.equal(run.errorCode, 'PROVIDER_AUTHENTICATION')
    assert.equal(run.recordsReceived, 0)
    assert.equal(run.recordsPersisted, 0)
    assert.equal(run.recordsFailed, 0)
    assert.lengthOf(await SourceRecord.all(), 0)
  })

  test('preserves committed TMS records when the next HTTP page fails', async ({ assert }) => {
    let requests = 0
    server.removeAllListeners('request')
    server.on('request', (request, response) => {
      requests++
      const page = new URL(request.url!, providerUrl).searchParams.get('page')
      response.writeHead(page === '2' ? 500 : 200, { 'Content-Type': 'application/json' })
      response.end(
        page === '2'
          ? '{"private":"provider-secret"}'
          : JSON.stringify({ items: [first, second], page: { current: 1, totalPages: 2 } })
      )
    })
    const configured = await Integration.create({ name: 'TMS', slug: 'tms', provider: 'tms' })
    const connector = new TmsConnector(
      new TmsClient({ url: providerUrl, apiKey: 'tms-sync-test', timeoutMs: 1000 })
    )
    const run = await failedOutcome(() =>
      new SyncEngine({ connectorResolver: () => connector, pageSize: 2 }).execute(configured.id)
    )
    assert.equal(run.status, 'PARTIAL')
    assert.equal(run.errorCode, 'PROVIDER_UNAVAILABLE')
    assert.equal(run.recordsReceived, 2)
    assert.equal(run.recordsPersisted, 2)
    assert.equal(run.recordsFailed, 0)
    assert.notInclude(run.errorMessage!, 'provider-secret')
    const records = await run.related('sourceRecords').query().orderBy('id')
    assert.deepEqual(
      records.map((record) => record.payload),
      [first, second]
    )
    assert.equal(requests, 2)
  })

  test('keeps pagination-cycle protection in the engine for a TMS integration', async ({
    assert,
  }) => {
    const configured = await Integration.create({ name: 'TMS', slug: 'tms', provider: 'tms' })
    let requests = 0
    const run = await failedOutcome(() =>
      new SyncEngine({
        connectorResolver: () => ({
          async fetchPage() {
            requests++
            return { records: [], nextCursor: 'same-cursor' }
          },
        }),
      }).execute(configured.id)
    )
    assert.equal(run.status, 'FAILED')
    assert.equal(run.errorCode, 'PAGINATION_CYCLE')
    assert.equal(run.recordsReceived, 0)
    assert.equal(requests, 2)
  })
})
