import type { SourceObservation } from '../integrations/connector.js'
import type { TmsShipment } from '../integrations/tms/tms_types.js'
import { canonicalAmount } from './shipment_normalizer.js'
import type {
  CanonicalShipmentStatus,
  NormalizedShipmentData,
  ShipmentNormalizer,
} from './shipment_normalizer.js'

export default class TmsShipmentNormalizer implements ShipmentNormalizer {
  normalize(observation: SourceObservation): NormalizedShipmentData {
    const record = observation.payload as TmsShipment
    let status: CanonicalShipmentStatus = 'UNKNOWN'
    switch (record.status) {
      case 'CRIADO':
        status = 'PENDING'
        break
      case 'EM_TRANSITO':
        status = 'IN_TRANSIT'
        break
      case 'FINALIZADO':
        status = 'DELIVERED'
        break
      case 'CANCELADO':
        status = 'CANCELED'
        break
    }
    return { shipmentKey: record.shipmentCode, status, amount: canonicalAmount(record.totalValue) }
  }
}
