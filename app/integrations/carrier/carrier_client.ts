import carrierConfig from '#config/carrier'
import {
  CarrierError,
  CarrierAuthenticationError,
  CarrierRateLimitError,
  CarrierUnavailableError,
  CarrierTimeoutError,
  CarrierPayloadValidationError,
  CarrierRequestError,
} from './carrier_errors.js'
import { validateCarrierPage } from './carrier_validator.js'
import type { CarrierClientOptions, CarrierPage, CarrierPageOptions } from './carrier_types.js'

export default class CarrierClient {
  constructor(
    private readonly options: CarrierClientOptions = {
      url: carrierConfig.url,
      token: carrierConfig.token.release(),
      timeoutMs: carrierConfig.timeoutMs,
    }
  ) {
    let url: URL
    try {
      url = new URL(options.url)
    } catch {
      throw new TypeError('Carrier URL must be a valid HTTP(S) base URL')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError(
        'Carrier URL must be an HTTP(S) base URL without credentials, query, or fragment'
      )
    }
    if (!options.token.trim() || /[\r\n]/.test(options.token)) {
      throw new TypeError('Carrier token must be a non-empty single-line value')
    }
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 2_147_483_647
    ) {
      throw new TypeError(
        'Carrier timeout must be a positive integer up to 2147483647 milliseconds'
      )
    }
    this.options = { ...options }
  }

  async fetchPage({ cursor, limit }: CarrierPageOptions = {}): Promise<CarrierPage> {
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor.length)) {
      throw new TypeError('Carrier cursor must be a non-empty string')
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw new TypeError('Carrier limit must be an integer between 1 and 100')
    }
    const url = new URL(`${this.options.url.replace(/\/$/, '')}/shipments`)
    if (cursor !== undefined) url.searchParams.set('cursor', cursor)
    if (limit !== undefined) url.searchParams.set('limit', String(limit))
    const signal = AbortSignal.timeout(this.options.timeoutMs)

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/json' },
        signal,
        redirect: 'manual',
      })
      if (response.status !== 200) {
        // Do not consume or expose error bodies. Release the connection resources.
        await response.body?.cancel()
        const status = response.status
        if (status === 401 || status === 403) {
          throw new CarrierAuthenticationError('Carrier authentication failed', status)
        }
        if (status === 429) throw new CarrierRateLimitError('Carrier rate limit exceeded', status)
        if (status >= 500) throw new CarrierUnavailableError('Carrier is unavailable', status)
        throw new CarrierRequestError('Carrier returned an unexpected HTTP status', status)
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof SyntaxError) {
          throw new CarrierPayloadValidationError('Carrier returned invalid JSON', response.status)
        }
        throw error
      }
      return validateCarrierPage(payload)
    } catch (error) {
      if (error instanceof CarrierError) throw error
      if (signal.aborted) throw new CarrierTimeoutError('Carrier request timed out')
      // Avoid leaking the URL, Authorization header, or low-level exception details.
      throw new CarrierUnavailableError('Unable to communicate with Carrier')
    }
  }
}
