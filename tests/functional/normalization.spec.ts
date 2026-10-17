import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import Integration from '#models/integration'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'
import NormalizedShipment from '#models/normalized_shipment'
import SyncEngine from '#services/sync_engine'
import { SyncExecutionError } from '#services/sync_engine_errors'
import type { SourceObservation } from '../../app/integrations/connector.js'
import Migration from '../../database/migrations/1792195200000_create_normalized_shipments_table.js'

const raw = {
  shipmentId: 'SHP-100',
  status: 'DELIVERED',
  amount: 1250.5,
  extra: { preserved: true },
}
function observation(payload: Record<string, unknown> = raw): SourceObservation {
  return {
    externalId: String(payload.shipmentId ?? payload.shipmentCode),
    sourceUpdatedAt: null,
    payload,
  }
}
async function integration(provider = 'carrier') {
  return Integration.create({ name: provider, slug: provider, provider })
}
async function failedOutcome(execute: () => Promise<SyncRun>) {
  try {
    await execute()
  } catch (error) {
    if (error instanceof SyncExecutionError) return SyncRun.findOrFail(error.runId)
    throw error
  }
  throw new Error('Expected failed synchronization')
}

test.group('M6 canonical persistence and synchronization', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('persists exact decimal strings and loads both model relationships', async ({ assert }) => {
    const configured = await integration()
    const run = await new SyncEngine({
      connectorResolver: () => ({
        async fetchPage() {
          return { records: [observation()], nextCursor: null }
        },
      }),
    }).execute(configured.id)
    const source = await SourceRecord.query()
      .where('syncRunId', run.id)
      .preload('normalizedShipment')
      .firstOrFail()
    const normalized = source.normalizedShipment
    assert.equal(normalized.shipmentKey, 'SHP-100')
    assert.equal(normalized.status, 'DELIVERED')
    assert.strictEqual(normalized.amount, '1250.50')
    assert.isTrue(normalized.createdAt.isValid)
    assert.deepEqual(source.payload, raw)
    await normalized.load('sourceRecord')
    assert.equal(normalized.sourceRecord.id, source.id)
  })

  for (const provider of ['carrier', 'tms']) {
    test(`${provider} unknown status succeeds and preserves its original raw value`, async ({
      assert,
    }) => {
      const configured = await integration(provider)
      const payload =
        provider === 'carrier'
          ? { ...raw, status: 'NEW_CARRIER_STATE' }
          : {
              shipmentCode: 'SHP-100',
              status: 'EM_SEPARACAO',
              totalValue: 1250.5,
              deliveryDate: '2026-10-04',
            }
      const run = await new SyncEngine({
        connectorResolver: () => ({
          async fetchPage() {
            return { records: [observation(payload)], nextCursor: null }
          },
        }),
      }).execute(configured.id)
      assert.equal(run.status, 'SUCCESS')
      const source = await SourceRecord.query().preload('normalizedShipment').firstOrFail()
      assert.deepEqual(source.payload, payload)
      assert.equal(source.normalizedShipment.status, 'UNKNOWN')
    })
  }

  test('stores equivalent canonical values from two different provider schemas', async ({
    assert,
  }) => {
    for (const provider of ['carrier', 'tms']) {
      const configured = await integration(provider)
      const payload =
        provider === 'carrier'
          ? raw
          : { shipmentCode: 'SHP-100', status: 'FINALIZADO', totalValue: 1250.5 }
      await new SyncEngine({
        connectorResolver: () => ({
          async fetchPage() {
            return { records: [observation(payload)], nextCursor: null }
          },
        }),
      }).execute(configured.id)
    }
    const rows = await NormalizedShipment.query().orderBy('id')
    assert.lengthOf(rows, 2)
    assert.deepEqual(
      rows.map((row) => [row.shipmentKey, row.status, row.amount]),
      [
        ['SHP-100', 'DELIVERED', '1250.50'],
        ['SHP-100', 'DELIVERED', '1250.50'],
      ]
    )
    assert.notEqual(rows[0].sourceRecordId, rows[1].sourceRecordId)
  })

  test('keeps separate raw and canonical history when a shipment changes status', async ({
    assert,
  }) => {
    const configured = await integration()
    for (const status of ['IN_TRANSIT', 'DELIVERED']) {
      await new SyncEngine({
        connectorResolver: () => ({
          async fetchPage() {
            return { records: [observation({ ...raw, status })], nextCursor: null }
          },
        }),
      }).execute(configured.id)
    }
    const rows = await SourceRecord.query().preload('normalizedShipment').orderBy('id')
    assert.lengthOf(rows, 2)
    assert.notEqual(rows[0].syncRunId, rows[1].syncRunId)
    assert.deepEqual(
      rows.map((row) => [row.payload.status, row.normalizedShipment.status]),
      [
        ['IN_TRANSIT', 'IN_TRANSIT'],
        ['DELIVERED', 'DELIVERED'],
      ]
    )
  })

  for (const priorPage of [false, true]) {
    test(`canonical insert failure rolls back its entire page with ${priorPage ? 'PARTIAL' : 'FAILED'}`, async ({
      assert,
      cleanup,
    }) => {
      const configured = await integration()
      // A test-only database trigger deterministically fails the second canonical
      // insert after an earlier raw/canonical pair was written in this page.
      await db.rawQuery(
        `CREATE FUNCTION m6_reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.shipment_key = 'FAIL' THEN RAISE EXCEPTION 'private database credentials'; END IF; RETURN NEW; END $$`
      )
      cleanup(async () => {
        await db.rawQuery('DROP TRIGGER IF EXISTS m6_reject_projection ON normalized_shipments')
        await db.rawQuery('DROP FUNCTION IF EXISTS m6_reject_projection()')
      })
      await db.rawQuery(
        'CREATE TRIGGER m6_reject_projection BEFORE INSERT ON normalized_shipments FOR EACH ROW EXECUTE FUNCTION m6_reject_projection()'
      )
      let requests = 0
      const run = await failedOutcome(() =>
        new SyncEngine({
          connectorResolver: () => ({
            async fetchPage() {
              if (++requests === 1 && priorPage)
                return { records: [observation()], nextCursor: 'next' }
              return {
                records: [
                  observation({ ...raw, shipmentId: 'PAGE-OK' }),
                  observation({ ...raw, shipmentId: 'FAIL' }),
                ],
                nextCursor: null,
              }
            },
          }),
        }).execute(configured.id)
      )
      assert.equal(run.status, priorPage ? 'PARTIAL' : 'FAILED')
      assert.equal(run.errorCode, 'PERSISTENCE_ERROR')
      assert.equal(run.recordsReceived, priorPage ? 3 : 2)
      assert.equal(run.recordsPersisted, priorPage ? 1 : 0)
      assert.equal(run.recordsFailed, 2)
      assert.notMatch(run.errorMessage!, /private|credentials|m6_reject/)
      const sources = await SourceRecord.all()
      const projections = await NormalizedShipment.all()
      assert.deepEqual(
        sources.map((row) => row.externalId),
        priorPage ? ['SHP-100'] : []
      )
      assert.deepEqual(
        projections.map((row) => row.shipmentKey),
        priorPage ? ['SHP-100'] : []
      )
    })
  }

  for (const priorPage of [false, true]) {
    test(`unrepresentable amount yields sanitized NORMALIZATION_ERROR and ${priorPage ? 'PARTIAL' : 'FAILED'}`, async ({
      assert,
    }) => {
      const configured = await integration()
      let requests = 0
      const run = await failedOutcome(() =>
        new SyncEngine({
          connectorResolver: () => ({
            async fetchPage() {
              if (++requests === 1 && priorPage)
                return { records: [observation()], nextCursor: 'next' }
              return {
                records: [
                  observation({ ...raw, shipmentId: 'PAGE-OK' }),
                  observation({ ...raw, shipmentId: 'INVALID', amount: 1.005, secret: 'private' }),
                ],
                nextCursor: null,
              }
            },
          }),
        }).execute(configured.id)
      )
      assert.equal(run.status, priorPage ? 'PARTIAL' : 'FAILED')
      assert.equal(run.errorCode, 'NORMALIZATION_ERROR')
      assert.equal(
        run.errorMessage,
        'Provider amount cannot be represented as a canonical shipment value'
      )
      assert.equal(run.recordsReceived, priorPage ? 3 : 2)
      assert.equal(run.recordsPersisted, priorPage ? 1 : 0)
      assert.equal(run.recordsFailed, 2)
      assert.lengthOf(await SourceRecord.all(), priorPage ? 1 : 0)
      assert.lengthOf(await NormalizedShipment.all(), priorPage ? 1 : 0)
    })
  }

  test('migration down/up preserves pre-M6 raw history without a backfill', async ({
    assert,
    cleanup,
  }) => {
    const configured = await integration()
    const run = await SyncRun.create({ integrationId: configured.id, status: 'SUCCESS' })
    const source = await SourceRecord.create({ syncRunId: run.id, externalId: 'OLD', payload: raw })
    await new Migration(db.connection(), 'm6', false).execDown()
    cleanup(async () => {
      if (!(await db.connection().schema.hasTable('normalized_shipments')))
        await new Migration(db.connection(), 'm6', false).execUp()
    })
    assert.isFalse(await db.connection().schema.hasTable('normalized_shipments'))
    const beforeApply = await SourceRecord.findOrFail(source.id)
    assert.deepEqual(beforeApply.payload, raw)
    await new Migration(db.connection(), 'm6', false).execUp()
    assert.lengthOf(await NormalizedShipment.all(), 0)
    await source.load('normalizedShipment')
    assert.isNull(source.normalizedShipment)
    const afterApply = await SourceRecord.findOrFail(source.id)
    assert.deepEqual(afterApply.payload, raw)
  })
})

test.group('M6 normalized shipment database constraints', (group) => {
  group.each.setup(() => testUtils.db().truncate())
  let source: SourceRecord
  group.each.setup(async () => {
    const configured = await integration()
    const run = await SyncRun.create({ integrationId: configured.id, status: 'RUNNING' })
    source = await SourceRecord.create({ syncRunId: run.id, externalId: 'SHP-100', payload: raw })
  })

  for (const field of ['source_record_id', 'shipment_key', 'status', 'amount']) {
    test(`database rejects missing ${field}`, async ({ assert }) => {
      const data: Record<string, unknown> = {
        source_record_id: source.id,
        shipment_key: 'SHP-100',
        status: 'DELIVERED',
        amount: '1250.50',
        created_at: new Date(),
      }
      delete data[field]
      await assert.rejects(
        () => db.table('normalized_shipments').insert(data),
        /not-null constraint/
      )
    })
  }
  test('database rejects dangling source foreign keys', async ({ assert }) => {
    await assert.rejects(
      () =>
        NormalizedShipment.create({
          sourceRecordId: 0,
          shipmentKey: 'SHP-100',
          status: 'DELIVERED',
          amount: '1.00',
        }),
      /foreign key constraint/
    )
  })
  test('database enforces one projection per source observation', async ({ assert }) => {
    const data = {
      sourceRecordId: source.id,
      shipmentKey: 'SHP-100',
      status: 'DELIVERED' as const,
      amount: '1.00',
    }
    await NormalizedShipment.create(data)
    await assert.rejects(() => NormalizedShipment.create(data), /unique constraint/)
  })
  test('database restricts deleting raw observations with projections', async ({ assert }) => {
    await NormalizedShipment.create({
      sourceRecordId: source.id,
      shipmentKey: 'SHP-100',
      status: 'DELIVERED',
      amount: '1.00',
    })
    await assert.rejects(() => source.delete(), /foreign key constraint/)
  })
  test('database rejects unsupported canonical statuses', async ({ assert }) => {
    await assert.rejects(
      () =>
        db.table('normalized_shipments').insert({
          source_record_id: source.id,
          shipment_key: 'SHP-100',
          status: 'FINALIZADO',
          amount: '1.00',
          created_at: new Date(),
        }),
      /check constraint/
    )
  })
  for (const amount of ['NaN', '10000000000000.00']) {
    test(`database rejects invalid amount ${amount}`, async ({ assert }) => {
      await assert.rejects(
        () =>
          db.table('normalized_shipments').insert({
            source_record_id: source.id,
            shipment_key: 'SHP-100',
            status: 'DELIVERED',
            amount,
            created_at: new Date(),
          }),
        /check constraint|numeric field overflow/
      )
    })
  }
})
