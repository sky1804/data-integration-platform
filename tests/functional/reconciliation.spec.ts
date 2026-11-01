import nodeAssert from 'node:assert/strict'
import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import Integration from '#models/integration'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'
import NormalizedShipment from '#models/normalized_shipment'
import ReconciliationRun from '#models/reconciliation_run'
import Discrepancy from '#models/discrepancy'
import ReconciliationEngine from '#services/reconciliation_engine'
import type { ReconciliationInput } from '#services/reconciliation_engine'
import {
  ReconciliationEngineError,
  ReconciliationExecutionError,
  ReconciliationFinalizationError,
} from '#services/reconciliation_engine_errors'
import type { ReconciliationErrorCode } from '#services/reconciliation_engine_errors'
import type { CanonicalShipmentStatus } from '../../app/normalization/shipment_normalizer.js'
import Migration from '../../database/migrations/1792281600000_create_reconciliation_tables.js'

interface Shipment {
  key: string
  status?: CanonicalShipmentStatus
  amount?: string
}
let sequence = 0
async function dataset(
  provider: string,
  shipments: Shipment[] = [],
  status: SyncRun['status'] = 'SUCCESS'
) {
  const integration = await Integration.create({
    name: provider,
    slug: `${provider}-${++sequence}`,
    provider,
  })
  const run = await SyncRun.create({
    integrationId: integration.id,
    status,
    recordsReceived: shipments.length,
    recordsPersisted: shipments.length,
  })
  const records: NormalizedShipment[] = []
  for (const [index, shipment] of shipments.entries()) {
    const source = await SourceRecord.create({
      syncRunId: run.id,
      externalId: `source-${index}`,
      payload: {
        provider,
        status: `RAW_${provider}`,
        amount: 'raw-private-value',
        deliveryDate: provider === 'tms' ? '2026-10-04' : null,
      },
    })
    records.push(
      await NormalizedShipment.create({
        sourceRecordId: source.id,
        shipmentKey: shipment.key,
        status: shipment.status ?? 'DELIVERED',
        amount: shipment.amount ?? '1250.50',
      })
    )
  }
  return { run, records, integration }
}
async function pair(carrier: Shipment[] = [{ key: 'A' }], tms: Shipment[] = [{ key: 'A' }]) {
  const c = await dataset('carrier', carrier)
  const t = await dataset('tms', tms)
  return { input: { carrierSyncRunId: c.run.id, tmsSyncRunId: t.run.id }, carrier: c, tms: t }
}
async function rejectBeforeAudit(input: ReconciliationInput, code: ReconciliationErrorCode) {
  await nodeAssert.rejects(
    () => new ReconciliationEngine().execute(input),
    (error) => error instanceof ReconciliationEngineError && error.code === code
  )
  const runs = await ReconciliationRun.all()
  const discrepancies = await Discrepancy.all()
  nodeAssert.equal(runs.length, 0)
  nodeAssert.equal(discrepancies.length, 0)
}
async function failedOutcome(input: ReconciliationInput) {
  try {
    await new ReconciliationEngine().execute(input)
  } catch (error) {
    if (error instanceof ReconciliationExecutionError)
      return ReconciliationRun.findOrFail(error.runId)
    throw error
  }
  throw new Error('Expected reconciliation failure')
}
async function faultTrigger(
  table: 'discrepancies' | 'reconciliation_runs',
  body: string,
  event = 'INSERT'
) {
  await db.rawQuery(
    `CREATE FUNCTION m7_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`
  )
  try {
    await db.rawQuery(
      `CREATE TRIGGER m7_test_fault BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION m7_test_fault()`
    )
  } catch (error) {
    await db.rawQuery('DROP FUNCTION m7_test_fault()')
    throw error
  }
  return async () => {
    await db.rawQuery(`DROP TRIGGER IF EXISTS m7_test_fault ON ${table}`)
    await db.rawQuery('DROP FUNCTION IF EXISTS m7_test_fault()')
  }
}

test.group('M7 historical reconciliation', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('exact canonical matches succeed despite different raw fields and dates', async ({
    assert,
  }) => {
    const { input } = await pair()
    const run = await new ReconciliationEngine().execute(input)
    assert.equal(run.status, 'SUCCESS')
    assert.equal(run.carrierSyncRunId, input.carrierSyncRunId)
    assert.equal(run.tmsSyncRunId, input.tmsSyncRunId)
    assert.deepEqual(
      [run.carrierRecords, run.tmsRecords, run.comparedRecords, run.discrepanciesFound],
      [1, 1, 1, 0]
    )
    assert.isTrue(run.startedAt!.isValid)
    assert.isTrue(run.finishedAt!.toMillis() >= run.startedAt!.toMillis())
    assert.isTrue(run.createdAt.isValid)
    assert.isTrue(run.updatedAt.isValid)
    assert.isNull(run.errorCode)
    assert.isNull(run.errorMessage)
    assert.lengthOf(await Discrepancy.all(), 0)
  })

  for (const [status, amount, expected] of [
    ['IN_TRANSIT', '1250.50', ['STATUS_MISMATCH']],
    ['DELIVERED', '1250.51', ['VALUE_MISMATCH']],
    ['IN_TRANSIT', '1300.00', ['STATUS_MISMATCH', 'VALUE_MISMATCH']],
  ] as const) {
    test(`creates exactly ${expected.join(' and ')} with both provenance references`, async ({
      assert,
    }) => {
      const selected = await pair([{ key: 'A' }], [{ key: 'A', status, amount }])
      const run = await new ReconciliationEngine().execute(selected.input)
      await run.load('carrierSyncRun')
      await run.load('tmsSyncRun')
      await run.load('discrepancies', (query) => query.orderBy('id'))
      assert.equal(run.carrierSyncRun.id, selected.carrier.run.id)
      assert.equal(run.tmsSyncRun.id, selected.tms.run.id)
      assert.deepEqual(
        run.discrepancies.map((row) => row.type),
        [...expected]
      )
      assert.equal(run.comparedRecords, 1)
      assert.equal(run.discrepanciesFound, expected.length)
      for (const discrepancy of run.discrepancies) {
        await discrepancy.load('reconciliationRun')
        await discrepancy.load('carrierNormalizedShipment', (query) =>
          query.preload('sourceRecord', (source) =>
            source.preload('syncRun', (sync) => sync.preload('integration'))
          )
        )
        await discrepancy.load('tmsNormalizedShipment')
        assert.equal(discrepancy.reconciliationRun.id, run.id)
        assert.equal(discrepancy.carrierNormalizedShipment.id, selected.carrier.records[0].id)
        assert.equal(discrepancy.tmsNormalizedShipment.id, selected.tms.records[0].id)
        assert.equal(
          discrepancy.carrierNormalizedShipment.sourceRecord.syncRun.integration.provider,
          'carrier'
        )
      }
    })
  }

  test('empty successful datasets reconcile with all counters zero', async ({ assert }) => {
    const { input } = await pair([], [])
    const run = await new ReconciliationEngine().execute(input)
    assert.equal(run.status, 'SUCCESS')
    assert.deepEqual(
      [run.carrierRecords, run.tmsRecords, run.comparedRecords, run.discrepanciesFound],
      [0, 0, 0, 0]
    )
    assert.lengthOf(await Discrepancy.all(), 0)
  })

  for (const missing of ['carrier', 'tms'] as const) {
    test(`missing ${missing} uses the correct null side and missing counter semantics`, async ({
      assert,
    }) => {
      const { input } = await pair(
        missing === 'carrier' ? [] : [{ key: 'A' }],
        missing === 'tms' ? [] : [{ key: 'A' }]
      )
      const run = await new ReconciliationEngine().execute(input)
      const row = await Discrepancy.query()
        .preload('carrierNormalizedShipment')
        .preload('tmsNormalizedShipment')
        .firstOrFail()
      assert.equal(row.type, missing === 'carrier' ? 'MISSING_IN_CARRIER' : 'MISSING_IN_TMS')
      assert.equal(run.carrierRecords, missing === 'carrier' ? 0 : 1)
      assert.equal(run.tmsRecords, missing === 'tms' ? 0 : 1)
      assert.equal(run.comparedRecords, 0)
      assert.equal(run.discrepanciesFound, 1)
      if (missing === 'carrier') {
        assert.isNull(row.carrierNormalizedShipmentId)
        assert.isNull(row.carrierNormalizedShipment)
        assert.isNotNull(row.tmsNormalizedShipment)
      } else {
        assert.isNull(row.tmsNormalizedShipmentId)
        assert.isNull(row.tmsNormalizedShipment)
        assert.isNotNull(row.carrierNormalizedShipment)
      }
    })
  }

  test('mixed datasets have deterministic key/type ordering and independent counters', async ({
    assert,
  }) => {
    const { input } = await pair(
      ['E', 'D', 'C', 'B', 'A'].map((key) => ({ key })),
      [
        { key: 'F' },
        { key: 'E', status: 'PENDING', amount: '1300.00' },
        { key: 'C', amount: '1300.00' },
        { key: 'B', status: 'PENDING' },
        { key: 'A' },
      ]
    )
    const run = await new ReconciliationEngine().execute(input)
    const rows = await Discrepancy.query().orderBy('id')
    assert.deepEqual(
      rows.map((row) => [row.shipmentKey, row.type]),
      [
        ['B', 'STATUS_MISMATCH'],
        ['C', 'VALUE_MISMATCH'],
        ['D', 'MISSING_IN_TMS'],
        ['E', 'STATUS_MISMATCH'],
        ['E', 'VALUE_MISMATCH'],
        ['F', 'MISSING_IN_CARRIER'],
      ]
    )
    assert.deepEqual(
      [run.carrierRecords, run.tmsRecords, run.comparedRecords, run.discrepanciesFound],
      [5, 5, 4, 6]
    )
  })

  for (const [carrierKey, tmsKey] of [
    ['SHP-100', 'shp-100'],
    ['00123', '123'],
    ['A', ' A '],
  ]) {
    test(`keys ${JSON.stringify(carrierKey)} and ${JSON.stringify(tmsKey)} are distinct`, async ({
      assert,
    }) => {
      const { input } = await pair([{ key: carrierKey }], [{ key: tmsKey }])
      const run = await new ReconciliationEngine().execute(input)
      const rows = await Discrepancy.query().orderBy('shipmentKey')
      assert.equal(run.comparedRecords, 0)
      assert.equal(run.discrepanciesFound, 2)
      assert.isTrue(
        rows.some((row) => row.shipmentKey === carrierKey && row.type === 'MISSING_IN_TMS')
      )
      assert.isTrue(
        rows.some((row) => row.shipmentKey === tmsKey && row.type === 'MISSING_IN_CARRIER')
      )
    })
  }

  for (const status of ['UNKNOWN', 'DELIVERED'] as const) {
    test(`UNKNOWN versus ${status} uses canonical status equality`, async ({ assert }) => {
      const { input } = await pair([{ key: 'A', status: 'UNKNOWN' }], [{ key: 'A', status }])
      const run = await new ReconciliationEngine().execute(input)
      const rows = await Discrepancy.all()
      assert.equal(run.discrepanciesFound, status === 'UNKNOWN' ? 0 : 1)
      assert.deepEqual(
        rows.map((row) => row.type),
        status === 'UNKNOWN' ? [] : ['STATUS_MISMATCH']
      )
    })
  }

  for (const [carrierAmount, tmsAmount, count] of [
    ['9999999999999.98', '9999999999999.99', 1],
    ['-1250.50', '-1250.50', 0],
    ['0.00', '0.01', 1],
  ] as const) {
    test(`compares ${carrierAmount} and ${tmsAmount} without numeric conversion or tolerance`, async ({
      assert,
    }) => {
      const { input } = await pair(
        [{ key: 'A', amount: carrierAmount }],
        [{ key: 'A', amount: tmsAmount }]
      )
      const run = await new ReconciliationEngine().execute(input)
      assert.equal(run.discrepanciesFound, count)
      if (count) {
        const row = await Discrepancy.query().firstOrFail()
        assert.equal(row.type, 'VALUE_MISMATCH')
      }
    })
  }

  test('repeated explicit pairs produce independent identical results and ignore newer runs', async ({
    assert,
  }) => {
    const selected = await pair([{ key: 'A' }], [{ key: 'A', status: 'PENDING' }])
    const engine = new ReconciliationEngine()
    const first = await engine.execute(selected.input)
    const firstRows = await first.related('discrepancies').query()
    const original = firstRows.map((row) => row.serialize())
    await dataset('carrier', [{ key: 'NEW' }])
    await dataset('tms', [{ key: 'NEW' }])
    const second = await engine.execute(selected.input)
    assert.notEqual(first.id, second.id)
    assert.equal(second.carrierSyncRunId, selected.carrier.run.id)
    assert.equal(second.tmsSyncRunId, selected.tms.run.id)
    const secondRows = await second.related('discrepancies').query()
    assert.deepEqual(
      secondRows.map((row) => [
        row.shipmentKey,
        row.type,
        row.carrierNormalizedShipmentId,
        row.tmsNormalizedShipmentId,
      ]),
      firstRows.map((row) => [
        row.shipmentKey,
        row.type,
        row.carrierNormalizedShipmentId,
        row.tmsNormalizedShipmentId,
      ])
    )
    const retained = await first.related('discrepancies').query()
    assert.deepEqual(
      retained.map((row) => row.serialize()),
      original
    )
    assert.lengthOf(await ReconciliationRun.all(), 2)
  })

  test('historical reconciliation works when integrations are currently disabled', async ({
    assert,
  }) => {
    const selected = await pair()
    for (const integration of [selected.carrier.integration, selected.tms.integration]) {
      integration.enabled = false
      await integration.save()
    }
    const run = await new ReconciliationEngine().execute(selected.input)
    assert.equal(run.status, 'SUCCESS')
  })

  for (const side of ['carrierSyncRunId', 'tmsSyncRunId'] as const) {
    test(`invalid ${side} rejects before any audit row`, async () => {
      const { input } = await pair()
      for (const id of [0, -1, 1.5, Number.NaN, Infinity, 2147483648, '1']) {
        await rejectBeforeAudit(
          { ...input, [side]: id } as ReconciliationInput,
          'INVALID_SYNC_RUN_ID'
        )
      }
    })
    test(`missing ${side} rejects before any audit row`, async () => {
      const { input } = await pair()
      await rejectBeforeAudit({ ...input, [side]: 2147483647 }, 'SYNC_RUN_NOT_FOUND')
    })
  }

  for (const provider of ['carrier', 'tms'] as const) {
    for (const status of ['PENDING', 'RUNNING', 'PARTIAL', 'FAILED'] as const) {
      test(`rejects ${provider} ${status} without false missing discrepancies`, async () => {
        const c = await dataset(
          'carrier',
          [{ key: 'A' }],
          provider === 'carrier' ? status : 'SUCCESS'
        )
        const t = await dataset('tms', [{ key: 'A' }], provider === 'tms' ? status : 'SUCCESS')
        await rejectBeforeAudit(
          { carrierSyncRunId: c.run.id, tmsSyncRunId: t.run.id },
          'SYNC_RUN_NOT_SUCCESS'
        )
      })
    }
  }

  for (const [carrierProvider, tmsProvider] of [
    ['tms', 'carrier'],
    ['carrier', 'carrier'],
    ['tms', 'tms'],
    ['unsupported', 'tms'],
    ['carrier', 'unsupported'],
  ]) {
    test(`rejects provider pair ${carrierProvider}/${tmsProvider}`, async () => {
      const c = await dataset(carrierProvider)
      const t = await dataset(tmsProvider)
      await rejectBeforeAudit(
        { carrierSyncRunId: c.run.id, tmsSyncRunId: t.run.id },
        'INVALID_PROVIDER_PAIR'
      )
    })
  }
  test('rejects the same run on both sides', async () => {
    const c = await dataset('carrier')
    await rejectBeforeAudit(
      { carrierSyncRunId: c.run.id, tmsSyncRunId: c.run.id },
      'INVALID_PROVIDER_PAIR'
    )
  })

  for (const provider of ['carrier', 'tms'] as const) {
    test(`rejects incomplete ${provider} normalization without interpreting it as missing shipments`, async () => {
      const selected = await pair()
      const run = selected[provider].run
      await SourceRecord.create({
        syncRunId: run.id,
        externalId: 'OLD',
        payload: { private: true },
      })
      await rejectBeforeAudit(selected.input, 'INCOMPLETE_NORMALIZATION')
    })
    test(`rejects duplicate canonical ${provider} keys even when source IDs differ`, async () => {
      const { input } = await pair(
        provider === 'carrier' ? [{ key: 'SAME' }, { key: 'SAME' }] : [],
        provider === 'tms' ? [{ key: 'SAME' }, { key: 'SAME' }] : []
      )
      await rejectBeforeAudit(input, 'DUPLICATE_SHIPMENT_KEY')
    })
  }

  test('sanitizes input database failure without creating an audit run', async ({ cleanup }) => {
    const { input } = await pair()
    const original = SyncRun.query
    SyncRun.query = () => {
      throw new Error('postgres://private:password stack trace')
    }
    cleanup(() => {
      SyncRun.query = original
    })
    await rejectBeforeAudit(input, 'PERSISTENCE_ERROR')
  })

  test('atomic insert failure after an earlier discrepancy rolls back every result', async ({
    assert,
    cleanup,
  }) => {
    const { input } = await pair([{ key: 'A' }, { key: 'B' }], [])
    cleanup(
      await faultTrigger(
        'discrepancies',
        `IF NEW.shipment_key = 'B' AND EXISTS (SELECT 1 FROM discrepancies WHERE reconciliation_run_id = NEW.reconciliation_run_id AND shipment_key = 'A') THEN RAISE EXCEPTION 'private credentials and SQL'; END IF;`
      )
    )
    const run = await failedOutcome(input)
    assert.equal(run.status, 'FAILED')
    assert.equal(run.errorCode, 'PERSISTENCE_ERROR')
    assert.equal(run.errorMessage, 'Unable to persist reconciliation results')
    assert.deepEqual(
      [run.carrierRecords, run.tmsRecords, run.comparedRecords, run.discrepanciesFound],
      [2, 0, 0, 0]
    )
    assert.isNotNull(run.finishedAt)
    assert.lengthOf(await Discrepancy.all(), 0)
    assert.lengthOf(await NormalizedShipment.all(), 2)
  })

  test('failure of transactional SUCCESS update also rolls back every discrepancy', async ({
    assert,
    cleanup,
  }) => {
    const { input } = await pair([{ key: 'A' }], [])
    cleanup(
      await faultTrigger(
        'reconciliation_runs',
        `IF NEW.status = 'SUCCESS' THEN RAISE EXCEPTION 'private Redis password'; END IF;`,
        'UPDATE'
      )
    )
    const run = await failedOutcome(input)
    assert.equal(run.status, 'FAILED')
    assert.equal(run.discrepanciesFound, 0)
    assert.equal(run.comparedRecords, 0)
    assert.equal(run.errorCode, 'PERSISTENCE_ERROR')
    assert.lengthOf(await Discrepancy.all(), 0)
  })

  test('start-state persistence failure attempts a FAILED audit', async ({ assert, cleanup }) => {
    const { input } = await pair()
    cleanup(
      await faultTrigger(
        'reconciliation_runs',
        `IF NEW.status = 'RUNNING' THEN RAISE EXCEPTION 'private'; END IF;`,
        'UPDATE'
      )
    )
    const run = await failedOutcome(input)
    assert.equal(run.status, 'FAILED')
    assert.equal(run.errorCode, 'PERSISTENCE_ERROR')
    assert.lengthOf(await Discrepancy.all(), 0)
  })

  test('failure to create an audit row is sanitized without claiming a run exists', async ({
    cleanup,
  }) => {
    const { input } = await pair()
    cleanup(
      await faultTrigger('reconciliation_runs', `RAISE EXCEPTION 'database connection password';`)
    )
    await rejectBeforeAudit(input, 'PERSISTENCE_ERROR')
  })

  test('FAILED finalization failure exposes run ID without claiming terminal persistence', async ({
    assert,
    cleanup,
  }) => {
    const { input } = await pair([{ key: 'A' }], [])
    cleanup(
      await faultTrigger(
        'reconciliation_runs',
        `IF NEW.status IN ('SUCCESS', 'FAILED') THEN RAISE EXCEPTION 'private'; END IF;`,
        'UPDATE'
      )
    )
    let failure: ReconciliationFinalizationError | undefined
    try {
      await new ReconciliationEngine().execute(input)
    } catch (error) {
      assert.instanceOf(error, ReconciliationFinalizationError)
      failure = error as ReconciliationFinalizationError
    }
    assert.isDefined(failure)
    assert.equal(failure!.code, 'RUN_FINALIZATION_ERROR')
    assert.notMatch(failure!.message, /private|password|SQL/)
    const run = await ReconciliationRun.findOrFail(failure!.runId)
    assert.equal(run.status, 'RUNNING')
    assert.isNull(run.finishedAt)
    assert.lengthOf(await Discrepancy.all(), 0)
  })

  test('post-commit refresh failure never relabels committed SUCCESS as FAILED', async ({
    assert,
    cleanup,
  }) => {
    const { input } = await pair([{ key: 'A' }], [])
    const original = ReconciliationRun.prototype.refresh
    ReconciliationRun.prototype.refresh = async () => {
      throw new Error('private SQL')
    }
    cleanup(() => {
      ReconciliationRun.prototype.refresh = original
    })
    await assert.rejects(
      () => new ReconciliationEngine().execute(input),
      ReconciliationFinalizationError
    )
    const run = await ReconciliationRun.query().firstOrFail()
    assert.equal(run.status, 'SUCCESS')
    assert.equal(run.discrepanciesFound, 1)
    assert.lengthOf(await Discrepancy.all(), 1)
  })

  test('migration rollback/reapply leaves pre-M7 raw and canonical history unchanged', async ({
    assert,
    cleanup,
  }) => {
    await pair()
    const rawBefore = await SourceRecord.all()
    const canonicalBefore = await NormalizedShipment.all()
    const rawSnapshot = rawBefore.map((row) => row.serialize())
    const canonicalSnapshot = canonicalBefore.map((row) => row.serialize())
    cleanup(async () => {
      if (!(await db.connection().schema.hasTable('reconciliation_runs')))
        await new Migration(db.connection(), 'm7', false).execUp()
    })
    await new Migration(db.connection(), 'm7', false).execDown()
    assert.isFalse(await db.connection().schema.hasTable('reconciliation_runs'))
    assert.isFalse(await db.connection().schema.hasTable('discrepancies'))
    await new Migration(db.connection(), 'm7', false).execUp()
    const rawAfter = await SourceRecord.all()
    const canonicalAfter = await NormalizedShipment.all()
    assert.deepEqual(
      rawAfter.map((row) => row.serialize()),
      rawSnapshot
    )
    assert.deepEqual(
      canonicalAfter.map((row) => row.serialize()),
      canonicalSnapshot
    )
    assert.lengthOf(await ReconciliationRun.all(), 0)
    assert.lengthOf(await Discrepancy.all(), 0)
  })
})

test.group('M7 reconciliation database constraints', (group) => {
  group.each.setup(() => testUtils.db().truncate())
  let selected: Awaited<ReturnType<typeof pair>>
  let run: ReconciliationRun
  group.each.setup(async () => {
    selected = await pair()
    run = await ReconciliationRun.create({ ...selected.input, status: 'PENDING' })
  })
  function discrepancy() {
    return {
      reconciliation_run_id: run.id,
      shipment_key: 'A',
      type: 'STATUS_MISMATCH',
      carrier_normalized_shipment_id: selected.carrier.records[0].id,
      tms_normalized_shipment_id: selected.tms.records[0].id,
      created_at: new Date(),
    }
  }

  test('defaults all counters to zero and optional execution/error fields to null', async ({
    assert,
  }) => {
    await run.refresh()
    assert.deepEqual(
      [run.carrierRecords, run.tmsRecords, run.comparedRecords, run.discrepanciesFound],
      [0, 0, 0, 0]
    )
    assert.isNull(run.startedAt)
    assert.isNull(run.finishedAt)
    assert.isNull(run.errorCode)
    assert.isNull(run.errorMessage)
  })
  test('rejects PARTIAL reconciliation status at the database boundary', async ({ assert }) => {
    await assert.rejects(
      () => db.from('reconciliation_runs').where('id', run.id).update({ status: 'PARTIAL' }),
      /check constraint/
    )
  })
  for (const column of ['carrier_sync_run_id', 'tms_sync_run_id']) {
    test(`requires ${column}`, async ({ assert }) => {
      await assert.rejects(
        () =>
          db
            .from('reconciliation_runs')
            .where('id', run.id)
            .update({ [column]: null }),
        /not-null constraint/
      )
    })
    test(`rejects dangling ${column}`, async ({ assert }) => {
      await assert.rejects(
        () =>
          db
            .from('reconciliation_runs')
            .where('id', run.id)
            .update({ [column]: 0 }),
        /foreign key constraint/
      )
    })
  }
  test('rejects the same SyncRun ID on both sides at the database boundary', async ({ assert }) => {
    await assert.rejects(
      () =>
        db
          .from('reconciliation_runs')
          .where('id', run.id)
          .update({ tms_sync_run_id: selected.carrier.run.id }),
      /check constraint/
    )
  })
  for (const column of [
    'carrier_records',
    'tms_records',
    'compared_records',
    'discrepancies_found',
  ]) {
    test(`rejects negative ${column}`, async ({ assert }) => {
      await assert.rejects(
        () =>
          db
            .from('reconciliation_runs')
            .where('id', run.id)
            .update({ [column]: -1 }),
        /check constraint/
      )
    })
  }
  test('rejects compared counters larger than either selected dataset', async ({ assert }) => {
    await assert.rejects(
      () =>
        db
          .from('reconciliation_runs')
          .where('id', run.id)
          .update({ carrier_records: 1, tms_records: 0, compared_records: 1 }),
      /check constraint/
    )
  })
  for (const column of ['reconciliation_run_id', 'shipment_key', 'type']) {
    test(`requires discrepancy ${column}`, async ({ assert }) => {
      const row: Record<string, unknown> = discrepancy()
      delete row[column]
      await assert.rejects(() => db.table('discrepancies').insert(row), /not-null constraint/)
    })
  }
  test('rejects unsupported discrepancy types', async ({ assert }) => {
    await assert.rejects(
      () => db.table('discrepancies').insert({ ...discrepancy(), type: 'DELIVERY_DATE_MISMATCH' }),
      /check constraint/
    )
  })
  for (const column of [
    'reconciliation_run_id',
    'carrier_normalized_shipment_id',
    'tms_normalized_shipment_id',
  ]) {
    test(`rejects dangling discrepancy ${column}`, async ({ assert }) => {
      await assert.rejects(
        () => db.table('discrepancies').insert({ ...discrepancy(), [column]: 0 }),
        /foreign key constraint/
      )
    })
  }
  test('rejects duplicate discrepancy types per run/key while allowing two different mismatch types', async ({
    assert,
  }) => {
    await db.table('discrepancies').insert(discrepancy())
    await db.table('discrepancies').insert({ ...discrepancy(), type: 'VALUE_MISMATCH' })
    await assert.rejects(() => db.table('discrepancies').insert(discrepancy()), /unique constraint/)
    assert.lengthOf(await Discrepancy.all(), 2)
  })
  for (const type of [
    'STATUS_MISMATCH',
    'VALUE_MISMATCH',
    'MISSING_IN_CARRIER',
    'MISSING_IN_TMS',
  ]) {
    test(`enforces the exact reference shape for ${type}`, async ({ assert }) => {
      for (const [index, [hasCarrier, hasTms]] of [
        [true, true],
        [true, false],
        [false, true],
        [false, false],
      ].entries()) {
        const valid =
          type === 'MISSING_IN_CARRIER'
            ? !hasCarrier && hasTms
            : type === 'MISSING_IN_TMS'
              ? hasCarrier && !hasTms
              : hasCarrier && hasTms
        const row = {
          ...discrepancy(),
          shipment_key: `shape-${index}`,
          type,
          carrier_normalized_shipment_id: hasCarrier ? selected.carrier.records[0].id : null,
          tms_normalized_shipment_id: hasTms ? selected.tms.records[0].id : null,
        }
        if (valid) await db.table('discrepancies').insert(row)
        else await assert.rejects(() => db.table('discrepancies').insert(row), /check constraint/)
      }
    })
  }
  for (const provider of ['carrier', 'tms'] as const) {
    test(`restricts deleting the ${provider} SyncRun even when its dataset is empty`, async ({
      assert,
    }) => {
      const empty = await pair([], [])
      await ReconciliationRun.create({ ...empty.input, status: 'PENDING' })
      await assert.rejects(
        () => empty[provider].run.delete(),
        new RegExp(`reconciliation_runs_${provider}_sync_run_id_foreign`)
      )
    })
    test(`restricts deleting referenced ${provider} canonical observations`, async ({ assert }) => {
      await db.table('discrepancies').insert(discrepancy())
      await assert.rejects(() => selected[provider].records[0].delete(), /foreign key constraint/)
    })
  }
  test('restricts deleting a reconciliation with discrepancy history', async ({ assert }) => {
    await db.table('discrepancies').insert(discrepancy())
    await assert.rejects(() => run.delete(), /foreign key constraint/)
  })
})
