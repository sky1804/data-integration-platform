import type { SourceObservation } from '../integrations/connector.js'

export type CanonicalShipmentStatus =
  'PENDING' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELED' | 'UNKNOWN'

export interface NormalizedShipmentData {
  shipmentKey: string
  status: CanonicalShipmentStatus
  amount: string
}

export interface ShipmentNormalizer {
  normalize(observation: SourceObservation): NormalizedShipmentData
}

export class NormalizationError extends Error {
  constructor() {
    super('Provider amount cannot be represented as a canonical shipment value')
    this.name = 'NormalizationError'
  }
}

/** Convert the parsed provider number to numeric(15,2), without rounding. */
export function canonicalAmount(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new NormalizationError()
  const match = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(String(value))
  if (!match) throw new NormalizationError()
  return `${match[1]}${match[2]}.${(match[3] ?? '').padEnd(2, '0')}`
}
