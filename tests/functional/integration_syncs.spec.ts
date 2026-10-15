import { test } from '@japa/runner'
import testUtils from '@adonisjs/core/services/test_utils'
import queue from '@adonisjs/queue/services/main'
import Integration from '#models/integration'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'
import SyncIntegrationJob from '#jobs/sync_integration_job'

test.group('M4 synchronization dispatch endpoint', (group) => {
  let fake: ReturnType<typeof queue.fake>
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    fake = queue.fake()
    return () => queue.restore()
  })

  test('accepts a request and only enqueues the integration ID', async ({ client, assert }) => {
    const integration = await Integration.create({
      name: 'Carrier',
      slug: 'carrier',
      provider: 'carrier',
    })
    const response = await client.post(`/integrations/${integration.id}/sync`)
    response.assertStatus(202)
    const body = response.body()
    assert.equal(body.status, 'queued')
    assert.equal(body.integrationId, integration.id)
    assert.isString(body.jobId)
    fake.assertPushed(SyncIntegrationJob, {
      queue: 'default',
      payload: { integrationId: integration.id },
    })
    fake.assertPushedCount(1)
    assert.equal(fake.getPushedJobs()[0].job.id, body.jobId)
    assert.deepEqual(Object.keys(body).sort(), ['integrationId', 'jobId', 'status'])
    assert.deepEqual(fake.getPushedJobs()[0].job.payload, { integrationId: integration.id })
    assert.isUndefined(fake.getPushedJobs()[0].job.dedup)
    assert.lengthOf(await SyncRun.all(), 0)
    assert.lengthOf(await SourceRecord.all(), 0)
  })

  for (const id of ['0', '-1', '1.5', 'abc', '1e2', '2147483648', '9007199254740993', '01']) {
    test(`rejects invalid integration ID ${id}`, async ({ client, assert }) => {
      const response = await client.post(`/integrations/${id}/sync`)
      response.assertStatus(400)
      response.assertBody({
        error: {
          code: 'INVALID_INTEGRATION_ID',
          message: 'Integration ID must be a positive integer',
        },
      })
      fake.assertNothingPushed()
      assert.lengthOf(await SyncRun.all(), 0)
      assert.lengthOf(await SourceRecord.all(), 0)
    })
  }

  test('rejects a missing integration', async ({ client, assert }) => {
    const response = await client.post('/integrations/2147483647/sync')
    response.assertStatus(404)
    response.assertBody({
      error: { code: 'INTEGRATION_NOT_FOUND', message: 'Integration does not exist' },
    })
    fake.assertNothingPushed()
    assert.lengthOf(await SyncRun.all(), 0)
  })

  for (const [attributes, status, code, message] of [
    [{ enabled: false }, 409, 'INTEGRATION_DISABLED', 'Integration is disabled'],
    [{ provider: 'tms' }, 422, 'UNSUPPORTED_PROVIDER', 'Integration provider is not supported'],
  ] as const) {
    test(`rejects ${code} without enqueueing or executing`, async ({ client, assert }) => {
      const integration = await Integration.create({
        name: 'Provider',
        slug: 'provider',
        provider: 'carrier',
        ...attributes,
      })
      const response = await client.post(`/integrations/${integration.id}/sync`)
      response.assertStatus(status)
      response.assertBody({ error: { code, message } })
      fake.assertNothingPushed()
      assert.lengthOf(await SyncRun.all(), 0)
      assert.lengthOf(await SourceRecord.all(), 0)
    })
  }

  test('returns a sanitized 503 if the queue rejects the push', async ({ client, assert }) => {
    const integration = await Integration.create({
      name: 'Carrier',
      slug: 'carrier',
      provider: 'carrier',
    })
    fake.pushOn = async () => {
      throw new Error('redis://secret-password@private-host:6379')
    }
    const response = await client.post(`/integrations/${integration.id}/sync`)
    response.assertStatus(503)
    response.assertBody({
      error: { code: 'QUEUE_UNAVAILABLE', message: 'Synchronization could not be queued' },
    })
    fake.assertNothingPushed()
    assert.lengthOf(await SyncRun.all(), 0)
  })

  test('allows two requests to enqueue two independent jobs', async ({ client, assert }) => {
    const integration = await Integration.create({
      name: 'Carrier',
      slug: 'carrier',
      provider: 'carrier',
    })
    const first = await client.post(`/integrations/${integration.id}/sync`)
    const second = await client.post(`/integrations/${integration.id}/sync`)
    first.assertStatus(202)
    second.assertStatus(202)
    assert.notEqual(first.body().jobId, second.body().jobId)
    fake.assertPushedCount(2)
    assert.lengthOf(await SyncRun.all(), 0)
  })

  test('sanitizes an unavailable integration lookup before dispatch', async ({
    client,
    cleanup,
    assert,
  }) => {
    const originalFind = Integration.find
    Integration.find = async () => {
      throw new Error('postgres-password raw SQL connection details')
    }
    cleanup(() => {
      Integration.find = originalFind
    })
    const response = await client.post('/integrations/1/sync')
    response.assertStatus(503)
    response.assertBody({
      error: { code: 'INTEGRATION_UNAVAILABLE', message: 'Integration could not be checked' },
    })
    fake.assertNothingPushed()
    assert.lengthOf(await SyncRun.all(), 0)
  })
})
