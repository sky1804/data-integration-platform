export type SyncFailureCode =
  | 'PROVIDER_AUTHENTICATION'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_PAYLOAD_INVALID'
  | 'PROVIDER_REQUEST_FAILED'
  | 'PERSISTENCE_ERROR'
  | 'PAGINATION_CYCLE'
  | 'UNEXPECTED_ERROR'

type SyncErrorCode =
  | SyncFailureCode
  | 'INTEGRATION_NOT_FOUND'
  | 'INTEGRATION_DISABLED'
  | 'UNSUPPORTED_PROVIDER'
  | 'RUN_FINALIZATION_ERROR'

export class SyncEngineError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class SyncExecutionError extends SyncEngineError {
  constructor(
    code: SyncFailureCode,
    message: string,
    readonly runId: number
  ) {
    super(code, message)
  }
}

export class SyncFinalizationError extends SyncEngineError {
  constructor(readonly runId: number) {
    super('RUN_FINALIZATION_ERROR', 'Unable to persist the synchronization outcome')
  }
}
