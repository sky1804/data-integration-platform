import { DateTime } from 'luxon'
import { TmsPayloadValidationError } from './tms_errors.js'
import type { TmsPage, TmsShipment } from './tms_types.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(field: string): never {
  throw new TmsPayloadValidationError(`Invalid TMS payload field: ${field}`, 200)
}

export function validateTmsPage(payload: unknown): TmsPage {
  if (!isObject(payload) || !Array.isArray(payload.items)) invalid('items')
  if (!isObject(payload.page)) invalid('page')
  const { current, totalPages } = payload.page
  if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 1)
    invalid('page.current')
  if (typeof totalPages !== 'number' || !Number.isSafeInteger(totalPages) || totalPages < current)
    invalid('page.totalPages')
  for (const [index, record] of payload.items.entries()) {
    const path = `items[${index}]`
    if (!isObject(record)) invalid(path)
    if (typeof record.shipmentCode !== 'string' || !record.shipmentCode.trim())
      invalid(`${path}.shipmentCode`)
    if (typeof record.status !== 'string') invalid(`${path}.status`)
    if (typeof record.totalValue !== 'number' || !Number.isFinite(record.totalValue))
      invalid(`${path}.totalValue`)
    if (
      record.deliveryDate !== null &&
      (typeof record.deliveryDate !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(record.deliveryDate) ||
        !DateTime.fromISO(record.deliveryDate, { zone: 'utc' }).isValid)
    )
      invalid(`${path}.deliveryDate`)
    if (
      typeof record.lastModifiedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
        record.lastModifiedAt
      ) ||
      !DateTime.fromISO(record.lastModifiedAt, { setZone: true }).isValid
    )
      invalid(`${path}.lastModifiedAt`)
  }
  return { records: payload.items as TmsShipment[], currentPage: current, totalPages }
}
