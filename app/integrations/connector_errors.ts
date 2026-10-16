export type ConnectorFailureKind =
  'AUTHENTICATION' | 'RATE_LIMIT' | 'UNAVAILABLE' | 'TIMEOUT' | 'PAYLOAD_INVALID' | 'REQUEST_FAILED'

const messages: Record<ConnectorFailureKind, string> = {
  AUTHENTICATION: 'Provider authentication failed',
  RATE_LIMIT: 'Provider rate limit exceeded',
  UNAVAILABLE: 'Provider is unavailable',
  TIMEOUT: 'Provider request timed out',
  PAYLOAD_INVALID: 'Provider returned an invalid payload',
  REQUEST_FAILED: 'Provider returned an unexpected response',
}

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorFailureKind,
    readonly httpStatus?: number
  ) {
    super(messages[kind])
    this.name = 'ConnectorError'
  }
}
