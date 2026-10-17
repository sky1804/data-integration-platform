import type { SourceObservation } from '../integrations/connector.js'
import type { CarrierShipment } from '../integrations/carrier/carrier_types.js'
import { canonicalAmount } from './shipment_normalizer.js'
import type {
  CanonicalShipmentStatus,
  NormalizedShipmentData,
  ShipmentNormalizer,
} from './shipment_normalizer.js'

export default class CarrierShipmentNormalizer implements ShipmentNormalizer {
  normalize(observation: SourceObservation): NormalizedShipmentData {
    const record = observation.payload as CarrierShipment
    let status: CanonicalShipmentStatus = 'UNKNOWN'
    switch (record.status) {
      case 'PENDING':
      case 'IN_TRANSIT':
      case 'DELIVERED':
      case 'CANCELED':
        status = record.status
    }
    return { shipmentKey: record.shipmentId, status, amount: canonicalAmount(record.amount) }
  }
}
