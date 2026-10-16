export interface TmsShipment extends Record<string, unknown> {
  shipmentCode: string
  status: string
  totalValue: number
  deliveryDate: string | null
  lastModifiedAt: string
}

export interface TmsPage {
  records: TmsShipment[]
  currentPage: number
  totalPages: number
}

export interface TmsPageOptions {
  page?: number
  pageSize?: number
}

export interface TmsClientOptions {
  url: string
  apiKey: string
  timeoutMs: number
}
