export class CarrierError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class CarrierAuthenticationError extends CarrierError {}
export class CarrierRateLimitError extends CarrierError {}
export class CarrierUnavailableError extends CarrierError {}
export class CarrierTimeoutError extends CarrierError {}
export class CarrierPayloadValidationError extends CarrierError {}
export class CarrierRequestError extends CarrierError {}
