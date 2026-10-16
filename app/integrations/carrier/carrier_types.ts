export interface CarrierShipment extends Record<string, unknown> {
  shipmentId: string
  status: string
  amount: number
  updatedAt: string
}

export interface CarrierPage {
  records: CarrierShipment[]
  nextCursor: string | null
}

export interface CarrierPageOptions {
  cursor?: string
  limit?: number
}

export interface CarrierClientOptions {
  url: string
  token: string
  timeoutMs: number
}
