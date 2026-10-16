export class TmsError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class TmsAuthenticationError extends TmsError {}
export class TmsRateLimitError extends TmsError {}
export class TmsUnavailableError extends TmsError {}
export class TmsTimeoutError extends TmsError {}
export class TmsPayloadValidationError extends TmsError {}
export class TmsRequestError extends TmsError {}
