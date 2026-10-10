import env from '#start/env'

export default {
  url: env.get('CARRIER_API_URL'),
  token: env.get('CARRIER_API_TOKEN'),
  timeoutMs: env.get('CARRIER_API_TIMEOUT_MS'),
}
