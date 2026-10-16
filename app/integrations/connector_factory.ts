import type { Connector } from './connector.js'
import CarrierConnector from './carrier/carrier_connector.js'
import TmsConnector from './tms/tms_connector.js'

export type SupportedProvider = 'carrier' | 'tms'

export function isSupportedProvider(provider: string): provider is SupportedProvider {
  return provider === 'carrier' || provider === 'tms'
}

export function createConnector(provider: SupportedProvider): Connector {
  switch (provider) {
    case 'carrier':
      return new CarrierConnector()
    case 'tms':
      return new TmsConnector()
    default:
      throw new TypeError('Unsupported connector provider')
  }
}
