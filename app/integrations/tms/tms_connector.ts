import { DateTime } from 'luxon'
import type { Connector, ConnectorPage, ConnectorPageOptions } from '../connector.js'
import { ConnectorError } from '../connector_errors.js'
import TmsClient from './tms_client.js'
import {
  TmsAuthenticationError,
  TmsRateLimitError,
  TmsUnavailableError,
  TmsTimeoutError,
  TmsPayloadValidationError,
  TmsRequestError,
} from './tms_errors.js'

export default class TmsConnector implements Connector {
  constructor(private readonly client: Pick<TmsClient, 'fetchPage'> = new TmsClient()) {}

  async fetchPage(options?: ConnectorPageOptions): Promise<ConnectorPage> {
    try {
      const cursor = options?.cursor
      if (
        cursor !== undefined &&
        (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
      ) {
        throw new ConnectorError('REQUEST_FAILED')
      }
      const page = await this.client.fetchPage({
        page: cursor === undefined ? 1 : Number(cursor),
        pageSize: options?.limit,
      })
      return {
        records: page.records.map((record) => ({
          externalId: record.shipmentCode,
          sourceUpdatedAt: DateTime.fromISO(record.lastModifiedAt, { setZone: true }),
          payload: record,
        })),
        nextCursor: page.currentPage < page.totalPages ? String(page.currentPage + 1) : null,
      }
    } catch (error) {
      if (error instanceof TmsAuthenticationError)
        throw new ConnectorError('AUTHENTICATION', error.httpStatus)
      if (error instanceof TmsRateLimitError)
        throw new ConnectorError('RATE_LIMIT', error.httpStatus)
      if (error instanceof TmsUnavailableError)
        throw new ConnectorError('UNAVAILABLE', error.httpStatus)
      if (error instanceof TmsTimeoutError) throw new ConnectorError('TIMEOUT', error.httpStatus)
      if (error instanceof TmsPayloadValidationError)
        throw new ConnectorError('PAYLOAD_INVALID', error.httpStatus)
      if (error instanceof TmsRequestError)
        throw new ConnectorError('REQUEST_FAILED', error.httpStatus)
      throw error
    }
  }
}
