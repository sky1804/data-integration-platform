import type { SupportedProvider } from '../integrations/connector_factory.js'
import type { ShipmentNormalizer } from './shipment_normalizer.js'
import CarrierShipmentNormalizer from './carrier_shipment_normalizer.js'
import TmsShipmentNormalizer from './tms_shipment_normalizer.js'

export function createShipmentNormalizer(provider: SupportedProvider): ShipmentNormalizer {
  switch (provider) {
    case 'carrier':
      return new CarrierShipmentNormalizer()
    case 'tms':
      return new TmsShipmentNormalizer()
    default:
      throw new TypeError('Unsupported shipment normalizer provider')
  }
}
