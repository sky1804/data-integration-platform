import { Job } from '@adonisjs/queue'
import type { JobOptions } from '@adonisjs/queue/types'
import SyncEngine from '#services/sync_engine'

interface SyncIntegrationPayload {
  integrationId: number
}

export default class SyncIntegrationJob extends Job<SyncIntegrationPayload> {
  static options: JobOptions = {
    queue: 'default',
    maxRetries: 0,
    // Bounded infrastructure history; SyncRun remains the business audit record.
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  }

  async execute() {
    await new SyncEngine().execute(this.payload.integrationId)
  }
}
