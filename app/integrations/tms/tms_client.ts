import tmsConfig from '#config/tms'
import {
  TmsError,
  TmsAuthenticationError,
  TmsRateLimitError,
  TmsUnavailableError,
  TmsTimeoutError,
  TmsPayloadValidationError,
  TmsRequestError,
} from './tms_errors.js'
import { validateTmsPage } from './tms_validator.js'
import type { TmsClientOptions, TmsPage, TmsPageOptions } from './tms_types.js'

export default class TmsClient {
  constructor(
    private readonly options: TmsClientOptions = {
      url: tmsConfig.url,
      apiKey: tmsConfig.apiKey.release(),
      timeoutMs: tmsConfig.timeoutMs,
    }
  ) {
    let url: URL
    try {
      url = new URL(options.url)
    } catch {
      throw new TypeError('TMS URL must be a valid HTTP(S) base URL')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError(
        'TMS URL must be an HTTP(S) base URL without credentials, query, or fragment'
      )
    }
    if (!options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) {
      throw new TypeError('TMS apiKey must be a non-empty single-line value')
    }
    if (
      !Number.isInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 2_147_483_647
    ) {
      throw new TypeError('TMS timeout must be a positive integer up to 2147483647 milliseconds')
    }
    this.options = { ...options }
  }

  async fetchPage({ page = 1, pageSize = 2 }: TmsPageOptions = {}): Promise<TmsPage> {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new TypeError('TMS page must be a positive safe integer')
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new TypeError('TMS page size must be an integer between 1 and 100')
    }
    const url = new URL(`${this.options.url.replace(/\/$/, '')}/shipments`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('pageSize', String(pageSize))
    const signal = AbortSignal.timeout(this.options.timeoutMs)

    try {
      const response = await fetch(url, {
        headers: { 'X-API-Key': this.options.apiKey, 'Accept': 'application/json' },
        signal,
        redirect: 'manual',
      })
      if (response.status !== 200) {
        // Do not consume or expose error bodies. Release the connection resources.
        await response.body?.cancel()
        const status = response.status
        if (status === 401 || status === 403) {
          throw new TmsAuthenticationError('TMS authentication failed', status)
        }
        if (status === 429) throw new TmsRateLimitError('TMS rate limit exceeded', status)
        if (status >= 500) throw new TmsUnavailableError('TMS is unavailable', status)
        throw new TmsRequestError('TMS returned an unexpected HTTP status', status)
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof SyntaxError) {
          throw new TmsPayloadValidationError('TMS returned invalid JSON', response.status)
        }
        throw error
      }
      const result = validateTmsPage(payload)
      if (result.currentPage !== page) {
        throw new TmsPayloadValidationError('TMS returned an unexpected page number', 200)
      }
      return result
    } catch (error) {
      if (error instanceof TmsError) throw error
      if (signal.aborted) throw new TmsTimeoutError('TMS request timed out')
      // Avoid leaking the URL, X-API-Key header, or low-level exception details.
      throw new TmsUnavailableError('Unable to communicate with TMS')
    }
  }
}
