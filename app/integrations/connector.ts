import type { DateTime } from 'luxon'

export interface SourceObservation {
  externalId: string
  sourceUpdatedAt: DateTime | null
  payload: Record<string, unknown>
}

export interface ConnectorPage {
  records: SourceObservation[]
  nextCursor: string | null
}

export interface ConnectorPageOptions {
  cursor?: string
  limit?: number
}

export interface Connector {
  fetchPage(options?: ConnectorPageOptions): Promise<ConnectorPage>
}
