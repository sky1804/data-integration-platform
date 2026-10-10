import { DateTime } from 'luxon'
import { CarrierPayloadValidationError } from './carrier_errors.js'
import type { CarrierPage, CarrierShipment } from './carrier_types.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(field: string): never {
  // Report the field, never the provider's potentially sensitive value.
  throw new CarrierPayloadValidationError(`Invalid Carrier payload field: ${field}`, 200)
}

export function validateCarrierPage(payload: unknown): CarrierPage {
  if (!isObject(payload) || !Array.isArray(payload.data)) invalid('data')
  if (!isObject(payload.pagination)) invalid('pagination')
  const nextCursor = payload.pagination.nextCursor
  if (nextCursor !== null && typeof nextCursor !== 'string') invalid('pagination.nextCursor')

  for (const [index, record] of payload.data.entries()) {
    const path = `data[${index}]`
    if (!isObject(record)) invalid(path)
    if (typeof record.shipmentId !== 'string' || record.shipmentId.trim().length === 0) {
      invalid(`${path}.shipmentId`)
    }
    if (typeof record.status !== 'string') invalid(`${path}.status`)
    if (typeof record.amount !== 'number' || !Number.isFinite(record.amount)) {
      invalid(`${path}.amount`)
    }
    // Require an ISO timestamp with seconds and a timezone; reject calendar overflow.
    if (
      typeof record.updatedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
        record.updatedAt
      ) ||
      !DateTime.fromISO(record.updatedAt, { setZone: true }).isValid
    ) {
      invalid(`${path}.updatedAt`)
    }
  }

  // Preserve the complete raw objects, including additional provider fields.
  return { records: payload.data as CarrierShipment[], nextCursor }
}
