import type { HttpContext } from '@adonisjs/core/http'
import Integration from '#models/integration'
import SyncIntegrationJob from '#jobs/sync_integration_job'

export default class IntegrationSyncsController {
  async store({ params, response }: HttpContext) {
    const reject = (status: number, code: string, message: string) =>
      response.status(status).send({ error: { code, message } })

    // IDs use PostgreSQL's existing serial/integer primary key.
    const id = Number(params.id)
    if (
      typeof params.id !== 'string' ||
      !/^[1-9]\d*$/.test(params.id) ||
      !Number.isSafeInteger(id) ||
      id > 2_147_483_647
    ) {
      return reject(400, 'INVALID_INTEGRATION_ID', 'Integration ID must be a positive integer')
    }

    let integration: Integration | null
    try {
      integration = await Integration.find(id)
    } catch {
      return reject(503, 'INTEGRATION_UNAVAILABLE', 'Integration could not be checked')
    }
    if (!integration) return reject(404, 'INTEGRATION_NOT_FOUND', 'Integration does not exist')
    if (!integration.enabled) return reject(409, 'INTEGRATION_DISABLED', 'Integration is disabled')
    if (integration.provider !== 'carrier') {
      return reject(422, 'UNSUPPORTED_PROVIDER', 'Integration provider is not supported')
    }

    try {
      const { jobId } = await SyncIntegrationJob.dispatch({ integrationId: id }).run()
      return response.accepted({ status: 'queued', integrationId: id, jobId })
    } catch {
      return reject(503, 'QUEUE_UNAVAILABLE', 'Synchronization could not be queued')
    }
  }
}
