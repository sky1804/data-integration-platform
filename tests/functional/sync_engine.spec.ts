import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import Integration from '#models/integration'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'
import SyncEngine from '#services/sync_engine'
import {
  SyncEngineError,
  SyncExecutionError,
  SyncFinalizationError,
} from '#services/sync_engine_errors'
import CarrierClient from '../../app/integrations/carrier/carrier_client.js'
import type { CarrierPage, CarrierShipment } from '../../app/integrations/carrier/carrier_types.js'
import {
  CarrierAuthenticationError,
  CarrierRateLimitError,
  CarrierUnavailableError,
  CarrierTimeoutError,
  CarrierPayloadValidationError,
  CarrierRequestError,
} from '../../app/integrations/carrier/carrier_errors.js'
import { createCarrierMockServer } from '../../mocks/carrier/server.js'

const raw = {
  shipmentId: 'SHP-100',
  status: 'IN_TRANSIT',
  amount: 1250.5,
  updatedAt: '2026-10-04T12:00:00Z',
  providerSpecificField: 'value',
  metadata: { tags: ['fragile'], confirmed: false },
}
const secondRaw = { ...raw, shipmentId: 'SHP-101', status: 'DELIVERED', amount: 890 }
const thirdRaw = { ...raw, shipmentId: 'SHP-102', status: 'PENDING', amount: 3500.25 }

function page(records: CarrierShipment[] = [], nextCursor: string | null = null): CarrierPage {
  return { records, nextCursor }
}

async function integration(attributes: Partial<Pick<Integration, 'enabled' | 'provider'>> = {}) {
  return Integration.create({
    name: 'Carrier demo',
    slug: 'carrier-demo',
    provider: 'carrier',
    ...attributes,
  })
}

async function outcome(execute: () => Promise<SyncRun>) {
  try {
    await execute()
  } catch (error) {
    if (error instanceof SyncExecutionError) return SyncRun.findOrFail(error.runId)
    throw error
  }
  throw new Error('Expected SyncExecutionError')
}

test.group('M3 synchronization engine', (group) => {
  // Real independent page commits, not savepoints inside M1's global transaction.
  group.each.setup(() => testUtils.db().truncate())

  test('commits multiple pages, raw records and progress before fetching the next page', async ({
    assert,
  }) => {
    const configured = await integration()
    let requests = 0
    const engine = new SyncEngine({
      pageSize: 2,
      carrierClient: {
        async fetchPage(options) {
          const stored = await SyncRun.query().where('integrationId', configured.id).firstOrFail()
          assert.equal(stored.status, 'RUNNING')
          assert.isTrue(stored.startedAt!.isValid)
          assert.isNull(stored.finishedAt)
          assert.isNull(stored.errorCode)
          assert.isNull(stored.errorMessage)
          assert.equal(options!.limit, 2)
          requests++
          if (requests === 1) {
            assert.isUndefined(options!.cursor)
            assert.equal(stored.recordsReceived, 0)
            assert.equal(stored.recordsPersisted, 0)
            assert.equal(stored.recordsFailed, 0)
            return page([raw, secondRaw], 'next')
          }
          assert.equal(options!.cursor, 'next')
          assert.equal(stored.recordsReceived, 2)
          assert.equal(stored.recordsPersisted, 2)
          // A separate transaction can see the previous committed page.
          await db.transaction(async (trx) => {
            const rows = await SourceRecord.query({ client: trx }).where('syncRunId', stored.id)
            assert.lengthOf(rows, 2)
          })
          return page([thirdRaw])
        },
      },
    })
    const result = await engine.execute(configured.id)
    const stored = await SyncRun.findOrFail(result.id)
    assert.equal(stored.status, 'SUCCESS')
    assert.equal(stored.integrationId, configured.id)
    assert.equal(stored.recordsReceived, 3)
    assert.equal(stored.recordsPersisted, 3)
    assert.equal(stored.recordsFailed, 0)
    assert.isAtLeast(stored.finishedAt!.toMillis(), stored.startedAt!.toMillis())
    assert.isNull(stored.errorCode)
    assert.isNull(stored.errorMessage)
    const records = await SourceRecord.query().where('syncRunId', stored.id).orderBy('id')
    assert.deepEqual(
      records.map((record) => record.externalId),
      ['SHP-100', 'SHP-101', 'SHP-102']
    )
    assert.deepEqual(
      records.map((record) => record.payload),
      [raw, secondRaw, thirdRaw]
    )
    assert.equal(records[0].sourceUpdatedAt!.toMillis(), DateTime.fromISO(raw.updatedAt).toMillis())
    assert.equal(requests, 2)
  })

  test('integrates the real CarrierClient and mock HTTP server with PostgreSQL', async ({
    assert,
    cleanup,
  }) => {
    const server = createCarrierMockServer({ token: 'm3-test-token' })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    cleanup(async () => {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    })
    const carrierClient = new CarrierClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: 'm3-test-token',
      timeoutMs: 1000,
    })
    const configured = await integration()
    const result = await new SyncEngine({ carrierClient, pageSize: 2 }).execute(configured.id)
    assert.equal(result.status, 'SUCCESS')
    assert.equal(result.recordsPersisted, 3)
    assert.lengthOf(await result.related('sourceRecords').query(), 3)
  })

  test('retains historical observations across independent executions', async ({ assert }) => {
    const configured = await integration()
    let current = raw
    const engine = new SyncEngine({
      carrierClient: {
        async fetchPage() {
          return page([current])
        },
      },
    })
    const first = await engine.execute(configured.id)
    current = { ...raw, status: 'DELIVERED', updatedAt: '2026-10-05T12:00:00Z' }
    const second = await engine.execute(configured.id)
    assert.notEqual(first.id, second.id)
    assert.lengthOf(await configured.related('syncRuns').query(), 2)
    const observations = await SourceRecord.query()
      .where('externalId', raw.shipmentId)
      .orderBy('id')
    assert.lengthOf(observations, 2)
    assert.deepEqual(observations[0].payload, raw)
    assert.deepEqual(observations[1].payload, current)
  })

  test('returns SUCCESS for an empty provider result', async ({ assert }) => {
    const configured = await integration()
    const run = await new SyncEngine({
      carrierClient: {
        async fetchPage() {
          return page()
        },
      },
    }).execute(configured.id)
    assert.equal(run.status, 'SUCCESS')
    assert.equal(run.recordsReceived, 0)
    assert.equal(run.recordsPersisted, 0)
    assert.equal(run.recordsFailed, 0)
    assert.isNotNull(run.startedAt)
    assert.isNotNull(run.finishedAt)
    assert.lengthOf(await SourceRecord.all(), 0)
  })

  for (const [ErrorClass, code] of [
    [CarrierAuthenticationError, 'PROVIDER_AUTHENTICATION'],
    [CarrierRateLimitError, 'PROVIDER_RATE_LIMIT'],
    [CarrierUnavailableError, 'PROVIDER_UNAVAILABLE'],
    [CarrierTimeoutError, 'PROVIDER_TIMEOUT'],
    [CarrierPayloadValidationError, 'PROVIDER_PAYLOAD_INVALID'],
    [CarrierRequestError, 'PROVIDER_REQUEST_FAILED'],
    [Error, 'UNEXPECTED_ERROR'],
  ] as const) {
    test(`finalizes ${code} before any returned page, without leaking the cause`, async ({
      assert,
    }) => {
      const configured = await integration()
      let requests = 0
      const engine = new SyncEngine({
        carrierClient: {
          async fetchPage() {
            requests++
            throw new ErrorClass(
              'Bearer secret-token password raw-provider-body https://private.example'
            )
          },
        },
      })
      const run = await outcome(() => engine.execute(configured.id))
      assert.equal(run.status, 'FAILED')
      assert.equal(run.errorCode, code)
      assert.equal(run.recordsReceived, 0)
      assert.equal(run.recordsPersisted, 0)
      assert.equal(run.recordsFailed, 0)
      assert.isNotNull(run.startedAt)
      assert.isNotNull(run.finishedAt)
      assert.notMatch(run.errorMessage!, /secret|password|Bearer|private|raw-provider-body/)
      assert.lengthOf(await SourceRecord.all(), 0)
      assert.equal(requests, 1)
    })
  }

  test('keeps committed pages after a later provider failure with no invented failed records', async ({
    assert,
  }) => {
    const configured = await integration()
    let requests = 0
    const engine = new SyncEngine({
      carrierClient: {
        async fetchPage() {
          if (++requests === 1) return page([raw, secondRaw], 'later')
          throw new CarrierUnavailableError('raw-sensitive-provider-body', 500)
        },
      },
    })
    const run = await outcome(() => engine.execute(configured.id))
    assert.equal(run.status, 'PARTIAL')
    assert.equal(run.errorCode, 'PROVIDER_UNAVAILABLE')
    assert.equal(run.recordsReceived, 2)
    assert.equal(run.recordsPersisted, 2)
    assert.equal(run.recordsFailed, 0)
    assert.isNotNull(run.finishedAt)
    assert.lengthOf(await run.related('sourceRecords').query(), 2)
    assert.equal(requests, 2)
  })

  test('fails after an empty page because no usable records were committed', async ({ assert }) => {
    const configured = await integration()
    let requests = 0
    const run = await outcome(() =>
      new SyncEngine({
        carrierClient: {
          async fetchPage() {
            if (++requests === 1) return page([], 'later')
            throw new CarrierTimeoutError('timeout')
          },
        },
      }).execute(configured.id)
    )
    assert.equal(run.status, 'FAILED')
    assert.equal(run.errorCode, 'PROVIDER_TIMEOUT')
    assert.equal(run.recordsFailed, 0)
    assert.equal(run.recordsReceived, 0)
  })

  for (const hasPreviousPage of [false, true]) {
    test(`rolls back an entire duplicate page ${hasPreviousPage ? 'after' : 'without'} an earlier commit`, async ({
      assert,
    }) => {
      const configured = await integration()
      let requests = 0
      const engine = new SyncEngine({
        carrierClient: {
          async fetchPage() {
            requests++
            if (hasPreviousPage && requests === 1) return page([raw], 'duplicate-page')
            // The first row of this page must disappear when the third row fails.
            return page([secondRaw, thirdRaw, thirdRaw], 'must-not-request')
          },
        },
      })
      const run = await outcome(() => engine.execute(configured.id))
      assert.equal(run.status, hasPreviousPage ? 'PARTIAL' : 'FAILED')
      assert.equal(run.errorCode, 'PERSISTENCE_ERROR')
      assert.equal(run.recordsReceived, hasPreviousPage ? 4 : 3)
      assert.equal(run.recordsPersisted, hasPreviousPage ? 1 : 0)
      assert.equal(run.recordsFailed, 3)
      assert.equal(run.recordsReceived, run.recordsPersisted + run.recordsFailed)
      const rows = await run.related('sourceRecords').query()
      assert.deepEqual(
        rows.map((record) => record.externalId),
        hasPreviousPage ? [raw.shipmentId] : []
      )
      assert.notInclude(run.errorMessage!, 'source_records_sync_run_id_external_id_unique')
      assert.isNotNull(run.finishedAt)
      assert.equal(requests, hasPreviousPage ? 2 : 1)
    })
  }

  test('rejects a repeated external ID across pages within one run without overwriting it', async ({
    assert,
  }) => {
    const configured = await integration()
    let requests = 0
    const run = await outcome(() =>
      new SyncEngine({
        carrierClient: {
          async fetchPage() {
            return ++requests === 1
              ? page([raw], 'next')
              : page([secondRaw, { ...raw, status: 'CANCELED' }])
          },
        },
      }).execute(configured.id)
    )
    assert.equal(run.status, 'PARTIAL')
    assert.equal(run.recordsReceived, 3)
    assert.equal(run.recordsPersisted, 1)
    assert.equal(run.recordsFailed, 2)
    const records = await run.related('sourceRecords').query()
    assert.deepEqual(records[0].payload, raw)
  })

  for (const [attributes, code] of [
    [{ enabled: false }, 'INTEGRATION_DISABLED'],
    [{ provider: 'tms' }, 'UNSUPPORTED_PROVIDER'],
  ] as const) {
    test(`rejects ${code} before run creation or provider access`, async ({ assert }) => {
      const configured = await integration(attributes)
      const engine = new SyncEngine({
        carrierClient: {
          async fetchPage() {
            assert.fail('No provider request expected')
            return page()
          },
        },
      })
      try {
        await engine.execute(configured.id)
        assert.fail('Expected integration rejection')
      } catch (error) {
        assert.instanceOf(error, SyncEngineError)
        assert.equal((error as SyncEngineError).code, code)
      }
      assert.lengthOf(await SyncRun.all(), 0)
      assert.lengthOf(await SourceRecord.all(), 0)
    })
  }

  test('rejects a missing integration before run creation', async ({ assert }) => {
    const engine = new SyncEngine({
      carrierClient: {
        async fetchPage() {
          return page()
        },
      },
    })
    try {
      await engine.execute(0)
      assert.fail('Expected missing integration error')
    } catch (error) {
      assert.instanceOf(error, SyncEngineError)
      assert.equal((error as SyncEngineError).code, 'INTEGRATION_NOT_FOUND')
    }
    assert.lengthOf(await SyncRun.all(), 0)
  })

  for (const persistRecords of [false, true]) {
    test(`detects cursor cycles with ${persistRecords ? 'PARTIAL' : 'FAILED'} outcome`, async ({
      assert,
    }) => {
      const configured = await integration()
      const seen: (string | undefined)[] = []
      const engine = new SyncEngine({
        carrierClient: {
          async fetchPage(options) {
            seen.push(options?.cursor)
            const records = persistRecords ? [{ ...raw, shipmentId: `SHP-${seen.length}` }] : []
            return page(records, options?.cursor === 'cursor-a' ? 'cursor-b' : 'cursor-a')
          },
        },
      })
      const run = await outcome(() => engine.execute(configured.id))
      assert.deepEqual(seen, [undefined, 'cursor-a', 'cursor-b'])
      assert.equal(run.errorCode, 'PAGINATION_CYCLE')
      assert.equal(run.status, persistRecords ? 'PARTIAL' : 'FAILED')
      assert.equal(run.recordsReceived, persistRecords ? 3 : 0)
      assert.equal(run.recordsPersisted, persistRecords ? 3 : 0)
      assert.equal(run.recordsFailed, 0)
      assert.isNotNull(run.finishedAt)
    })
  }

  test('keeps simultaneous executions independent on the same engine instance', async ({
    assert,
  }) => {
    const configured = await integration()
    const engine = new SyncEngine({
      carrierClient: {
        async fetchPage(options) {
          return options?.cursor === undefined ? page([raw], 'next') : page([secondRaw])
        },
      },
    })
    const runs = await Promise.all([engine.execute(configured.id), engine.execute(configured.id)])
    assert.notEqual(runs[0].id, runs[1].id)
    for (const run of runs) {
      assert.equal(run.status, 'SUCCESS')
      assert.equal(run.recordsPersisted, 2)
      assert.lengthOf(await run.related('sourceRecords').query(), 2)
    }
  })

  test('rejects invalid page sizes before execution', ({ assert }) => {
    for (const pageSize of [0, -1, 1.5, 101, Number.NaN]) {
      assert.throws(() => new SyncEngine({ pageSize }), TypeError)
    }
  })

  test('reports finalization failure without claiming an audit outcome was saved', async ({
    assert,
  }) => {
    const configured = await integration()
    let runId = 0
    const engine = new SyncEngine({
      carrierClient: {
        async fetchPage() {
          const run = await SyncRun.query().firstOrFail()
          runId = run.id
          // Simulate losing the audit row before finalization; no source rows exist.
          await run.delete()
          throw new CarrierTimeoutError('secret')
        },
      },
    })
    try {
      await engine.execute(configured.id)
      assert.fail('Expected finalization error')
    } catch (error) {
      assert.instanceOf(error, SyncFinalizationError)
      assert.equal((error as SyncFinalizationError).runId, runId)
      assert.equal((error as SyncFinalizationError).code, 'RUN_FINALIZATION_ERROR')
      assert.notInclude(String(error), 'secret')
    }
  })
})
