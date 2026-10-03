import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import Integration from '#models/integration'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'

test.group('Integration persistence', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('persists an integration with Lucid timestamps', async ({ assert }) => {
    const integration = await Integration.create({
      name: 'Carrier Demo',
      slug: 'carrier-demo',
      provider: 'carrier',
    })
    const stored = await Integration.findOrFail(integration.id)
    assert.equal(stored.name, 'Carrier Demo')
    assert.equal(stored.slug, 'carrier-demo')
    assert.equal(stored.provider, 'carrier')
    assert.isTrue(stored.createdAt.isValid)
    assert.isTrue(stored.updatedAt.isValid)
  })

  test('defaults enabled to true', async ({ assert }) => {
    const integration = await Integration.create({
      name: 'Carrier Demo',
      slug: 'carrier-demo',
      provider: 'carrier',
    })
    await integration.refresh()
    assert.isTrue(integration.enabled)
  })

  test('rejects duplicate slugs', async ({ assert }) => {
    await Integration.create({ name: 'Carrier Demo', slug: 'carrier-demo', provider: 'carrier' })
    await assert.rejects(
      () =>
        Integration.create({ name: 'Another Carrier', slug: 'carrier-demo', provider: 'carrier' }),
      /integrations_slug_unique/
    )
  })
})

test.group('SyncRun persistence', (group) => {
  let integration: Integration
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(async () => {
    integration = await Integration.create({
      name: 'Carrier Demo',
      slug: 'carrier-demo',
      provider: 'carrier',
    })
  })

  test('belongs to its integration', async ({ assert }) => {
    const run = await integration.related('syncRuns').create({ status: 'PENDING' })
    const stored = await SyncRun.findOrFail(run.id)
    await stored.load('integration')
    assert.equal(stored.integrationId, integration.id)
    assert.equal(stored.integration.slug, integration.slug)
  })

  test('loads an integration’s sync runs', async ({ assert }) => {
    const first = await integration.related('syncRuns').create({ status: 'SUCCESS' })
    const second = await integration.related('syncRuns').create({ status: 'PENDING' })
    await integration.load('syncRuns')
    assert.sameMembers(
      integration.syncRuns.map((run) => run.id),
      [first.id, second.id]
    )
  })

  test('defaults counters to zero and optional execution fields to null', async ({ assert }) => {
    const run = await integration.related('syncRuns').create({ status: 'PENDING' })
    await run.refresh()
    assert.equal(run.recordsReceived, 0)
    assert.equal(run.recordsPersisted, 0)
    assert.equal(run.recordsFailed, 0)
    assert.isNull(run.startedAt)
    assert.isNull(run.finishedAt)
    assert.isNull(run.errorCode)
    assert.isNull(run.errorMessage)
  })

  test('persists all five supported statuses and execution fields', async ({ assert }) => {
    const statuses: SyncRun['status'][] = ['PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED']
    for (const status of statuses) {
      const run = await integration.related('syncRuns').create({ status })
      await run.refresh()
      assert.equal(run.status, status)
    }
    const startedAt = DateTime.fromISO('2026-10-02T10:00:00Z')
    const finishedAt = startedAt.plus({ minutes: 2 })
    const partial = await integration.related('syncRuns').create({
      status: 'PARTIAL',
      startedAt,
      finishedAt,
      recordsReceived: 500,
      recordsPersisted: 498,
      recordsFailed: 2,
      errorCode: 'INVALID_RECORD',
      errorMessage: 'Two provider records could not be persisted.',
    })
    await partial.refresh()
    assert.equal(partial.startedAt?.toMillis(), startedAt.toMillis())
    assert.equal(partial.finishedAt?.toMillis(), finishedAt.toMillis())
    assert.equal(partial.recordsReceived, 500)
    assert.equal(partial.recordsPersisted, 498)
    assert.equal(partial.recordsFailed, 2)
    assert.equal(partial.errorCode, 'INVALID_RECORD')
    assert.equal(partial.errorMessage, 'Two provider records could not be persisted.')
  })

  test('rejects unsupported statuses at the database boundary', async ({ assert }) => {
    await assert.rejects(
      () =>
        db.table('sync_runs').insert({
          integration_id: integration.id,
          status: 'CANCELED',
          created_at: new Date(),
          updated_at: new Date(),
        }),
      /check constraint/
    )
  })

  test('rejects runs with a missing integration', async ({ assert }) => {
    await assert.rejects(
      () => SyncRun.create({ integrationId: 0, status: 'PENDING' }),
      /sync_runs_integration_id_foreign/
    )
  })

  test('restricts deleting an integration with synchronization history', async ({ assert }) => {
    await integration.related('syncRuns').create({ status: 'SUCCESS' })
    await assert.rejects(() => integration.delete(), /sync_runs_integration_id_foreign/)
  })
})

test.group('SourceRecord history', (group) => {
  let run: SyncRun
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(async () => {
    const integration = await Integration.create({
      name: 'Carrier Demo',
      slug: 'carrier-demo',
      provider: 'carrier',
    })
    run = await integration.related('syncRuns').create({ status: 'RUNNING' })
  })

  test('belongs to a run and reaches its integration through that run', async ({ assert }) => {
    const record = await run
      .related('sourceRecords')
      .create({ externalId: 'SHP-100', payload: { shipmentId: 'SHP-100' } })
    const stored = await SourceRecord.findOrFail(record.id)
    await stored.load('syncRun', (query) => query.preload('integration'))
    assert.equal(stored.syncRunId, run.id)
    assert.equal(stored.syncRun.integration.id, run.integrationId)
  })

  test('loads a run’s source records', async ({ assert }) => {
    const first = await run
      .related('sourceRecords')
      .create({ externalId: 'SHP-100', payload: { shipmentId: 'SHP-100' } })
    const second = await run
      .related('sourceRecords')
      .create({ externalId: 'SHP-101', payload: { shipmentId: 'SHP-101' } })
    await run.load('sourceRecords')
    assert.sameMembers(
      run.sourceRecords.map((record) => record.id),
      [first.id, second.id]
    )
  })

  test('round-trips JSONB structure without normalizing provider values', async ({ assert }) => {
    const payload = {
      shipment_code: 'SHP-100',
      status: 'FINALIZADO',
      amount: 1599.9,
      metadata: {
        optional: null,
        confirmed: true,
        tags: ['fragile', 'priority'],
        stops: [{ sequence: 1, delivered: false }],
      },
    }
    const sourceUpdatedAt = DateTime.fromISO('2026-10-02T12:34:56Z')
    const record = await run
      .related('sourceRecords')
      .create({ externalId: 'SHP-100', payload, sourceUpdatedAt })
    const stored = await SourceRecord.findOrFail(record.id)
    assert.deepEqual(stored.payload, payload)
    assert.equal(stored.sourceUpdatedAt?.toMillis(), sourceUpdatedAt.toMillis())
    assert.isTrue(stored.createdAt.isValid)
  })

  test('rejects duplicate external IDs within the same run', async ({ assert }) => {
    await run
      .related('sourceRecords')
      .create({ externalId: 'SHP-100', payload: { status: 'IN_TRANSIT' } })
    await assert.rejects(
      () =>
        run
          .related('sourceRecords')
          .create({ externalId: 'SHP-100', payload: { status: 'DELIVERED' } }),
      /source_records_sync_run_id_external_id_unique/
    )
  })

  test('retains different observations of the same external ID across runs', async ({ assert }) => {
    const first = await run
      .related('sourceRecords')
      .create({ externalId: 'SHP-100', payload: { status: 'IN_TRANSIT' } })
    const later = await SyncRun.create({ integrationId: run.integrationId, status: 'PENDING' })
    const second = await later
      .related('sourceRecords')
      .create({ externalId: 'SHP-100', payload: { status: 'DELIVERED' } })
    const earlierObservation = await SourceRecord.findOrFail(first.id)
    const laterObservation = await SourceRecord.findOrFail(second.id)
    assert.notEqual(first.id, second.id)
    assert.deepEqual(earlierObservation.payload, { status: 'IN_TRANSIT' })
    assert.deepEqual(laterObservation.payload, { status: 'DELIVERED' })
    assert.isNull(earlierObservation.sourceUpdatedAt)
  })

  test('rejects source records with a missing run', async ({ assert }) => {
    await assert.rejects(
      () => SourceRecord.create({ syncRunId: 0, externalId: 'SHP-100', payload: {} }),
      /source_records_sync_run_id_foreign/
    )
  })

  test('restricts deleting a run with source observations', async ({ assert }) => {
    await run.related('sourceRecords').create({ externalId: 'SHP-100', payload: {} })
    await assert.rejects(() => run.delete(), /source_records_sync_run_id_foreign/)
  })
})
