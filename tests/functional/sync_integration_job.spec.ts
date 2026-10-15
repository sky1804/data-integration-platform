import { test } from '@japa/runner'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import testUtils from '@adonisjs/core/services/test_utils'
import app from '@adonisjs/core/services/app'
import queue from '@adonisjs/queue/services/main'
import { Locator, Worker } from '@adonisjs/queue'
import type { QueueConfig } from '@adonisjs/queue/types'
import { FakeAdapter } from '@boringnode/queue/drivers/fake_adapter'
import Integration from '#models/integration'
import SyncRun from '#models/sync_run'
import SourceRecord from '#models/source_record'
import SyncIntegrationJob from '#jobs/sync_integration_job'
import carrierConfig from '#config/carrier'
import { createCarrierMockServer } from '../../mocks/carrier/server.js'

test.group('M4 job execution through the supported worker', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  for (const scenario of ['normal', 'unauthorized', 'disabled-after-dispatch'] as const) {
    test(`executes ${scenario} and preserves the engine outcome`, async ({ assert, cleanup }) => {
      const server = createCarrierMockServer({
        token: carrierConfig.token.release(),
        scenario: scenario === 'unauthorized' ? scenario : 'normal',
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const originalUrl = carrierConfig.url
      carrierConfig.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      let requests = 0
      server.on('request', () => requests++)
      cleanup(async () => {
        carrierConfig.url = originalUrl
        const closed = once(server, 'close')
        server.close()
        server.closeAllConnections()
        await closed
      })

      // Official Worker.processCycle hydrates and executes the real job. Avoid
      // calling the package's internal $hydrate API from application/test code.
      const config = app.config.get<QueueConfig>('queue')
      const originalAdapter = queue.use()
      const jobFactory = queue.getJobFactory()
      const logger = queue.getLogger()
      const fake = new FakeAdapter()
      const worker = new Worker({
        ...config,
        adapters: { redis: () => fake },
        jobFactory,
        logger,
        autoLoadJobs: false,
      })
      cleanup(async () => {
        await worker.stop()
        await queue.init({
          ...config,
          adapters: { redis: () => originalAdapter },
          jobFactory,
          logger,
          autoLoadJobs: false,
        })
        await queue.loadJobs()
      })
      await worker.init()
      assert.strictEqual(Locator.getOrThrow('SyncIntegrationJob'), SyncIntegrationJob)
      assert.equal(SyncIntegrationJob.options.maxRetries, 0)
      const integration = await Integration.create({
        name: 'Carrier',
        slug: 'carrier',
        provider: 'carrier',
      })
      const { jobId } = await SyncIntegrationJob.dispatch({ integrationId: integration.id }).run()
      assert.lengthOf(await SyncRun.all(), 0)
      if (scenario === 'disabled-after-dispatch') {
        integration.enabled = false
        await integration.save()
      }

      let job = await fake.getJob(jobId, 'default')
      assert.equal(job!.status, 'pending')
      for (let cycleCount = 0; cycleCount < 10; cycleCount++) {
        const cycle = await worker.processCycle(['default'])
        if (cycle?.type === 'error') throw cycle.error
        job = await fake.getJob(jobId, 'default')
        if (job?.status === 'completed' || job?.status === 'failed') break
      }
      assert.equal(job!.status, scenario === 'normal' ? 'completed' : 'failed')
      assert.equal(job!.data.attempts, 0)
      assert.equal(await fake.sizeOf('default'), 0)
      const runs = await SyncRun.all()
      if (scenario === 'disabled-after-dispatch') {
        assert.lengthOf(runs, 0)
        assert.include(job!.error!, 'Integration is disabled')
        assert.equal(requests, 0)
      } else {
        assert.lengthOf(runs, 1)
        assert.equal(runs[0].status, scenario === 'normal' ? 'SUCCESS' : 'FAILED')
        assert.equal(runs[0].recordsPersisted, scenario === 'normal' ? 3 : 0)
        assert.isNotNull(runs[0].finishedAt)
        assert.equal(runs[0].errorCode, scenario === 'normal' ? null : 'PROVIDER_AUTHENTICATION')
        assert.equal(requests, 1)
      }
      assert.lengthOf(await SourceRecord.all(), scenario === 'normal' ? 3 : 0)
    })
  }
})
