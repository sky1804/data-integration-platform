export type ReconciliationFailureCode = 'PERSISTENCE_ERROR' | 'UNEXPECTED_ERROR'

export type ReconciliationErrorCode =
  | ReconciliationFailureCode
  | 'INVALID_SYNC_RUN_ID'
  | 'SYNC_RUN_NOT_FOUND'
  | 'SYNC_RUN_NOT_SUCCESS'
  | 'INVALID_PROVIDER_PAIR'
  | 'INCOMPLETE_NORMALIZATION'
  | 'DUPLICATE_SHIPMENT_KEY'
  | 'RUN_FINALIZATION_ERROR'

export class ReconciliationEngineError extends Error {
  constructor(
    readonly code: ReconciliationErrorCode,
    message: string
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class ReconciliationExecutionError extends ReconciliationEngineError {
  constructor(
    code: ReconciliationFailureCode,
    message: string,
    readonly runId: number
  ) {
    super(code, message)
  }
}

export class ReconciliationFinalizationError extends ReconciliationEngineError {
  constructor(readonly runId: number) {
    super('RUN_FINALIZATION_ERROR', 'Unable to confirm the reconciliation outcome')
  }
}
