import env from '#start/env'

export default {
  url: env.get('TMS_API_URL'),
  apiKey: env.get('TMS_API_KEY'),
  timeoutMs: env.get('TMS_API_TIMEOUT_MS'),
}
