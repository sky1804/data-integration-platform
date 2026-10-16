import { DateTime } from 'luxon'
import type { Connector, ConnectorPage, ConnectorPageOptions } from '../connector.js'
import { ConnectorError } from '../connector_errors.js'
import CarrierClient from './carrier_client.js'
import {
  CarrierAuthenticationError,
  CarrierRateLimitError,
  CarrierUnavailableError,
  CarrierTimeoutError,
  CarrierPayloadValidationError,
  CarrierRequestError,
} from './carrier_errors.js'

export default class CarrierConnector implements Connector {
  constructor(private readonly client: Pick<CarrierClient, 'fetchPage'> = new CarrierClient()) {}

  async fetchPage(options?: ConnectorPageOptions): Promise<ConnectorPage> {
    try {
      const page = await this.client.fetchPage(options)
      return {
        records: page.records.map((record) => ({
          externalId: record.shipmentId,
          sourceUpdatedAt: DateTime.fromISO(record.updatedAt, { setZone: true }),
          payload: record,
        })),
        nextCursor: page.nextCursor,
      }
    } catch (error) {
      if (error instanceof CarrierAuthenticationError)
        throw new ConnectorError('AUTHENTICATION', error.httpStatus)
      if (error instanceof CarrierRateLimitError)
        throw new ConnectorError('RATE_LIMIT', error.httpStatus)
      if (error instanceof CarrierUnavailableError)
        throw new ConnectorError('UNAVAILABLE', error.httpStatus)
      if (error instanceof CarrierTimeoutError)
        throw new ConnectorError('TIMEOUT', error.httpStatus)
      if (error instanceof CarrierPayloadValidationError)
        throw new ConnectorError('PAYLOAD_INVALID', error.httpStatus)
      if (error instanceof CarrierRequestError)
        throw new ConnectorError('REQUEST_FAILED', error.httpStatus)
      throw error
    }
  }
}
