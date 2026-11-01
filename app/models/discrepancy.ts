import { DiscrepancySchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import ReconciliationRun from '#models/reconciliation_run'
import NormalizedShipment from '#models/normalized_shipment'

export type DiscrepancyType =
  'STATUS_MISMATCH' | 'VALUE_MISMATCH' | 'MISSING_IN_CARRIER' | 'MISSING_IN_TMS'

export default class Discrepancy extends DiscrepancySchema {
  declare type: DiscrepancyType

  @belongsTo(() => ReconciliationRun)
  declare reconciliationRun: BelongsTo<typeof ReconciliationRun>

  @belongsTo(() => NormalizedShipment, { foreignKey: 'carrierNormalizedShipmentId' })
  declare carrierNormalizedShipment: BelongsTo<typeof NormalizedShipment>

  @belongsTo(() => NormalizedShipment, { foreignKey: 'tmsNormalizedShipmentId' })
  declare tmsNormalizedShipment: BelongsTo<typeof NormalizedShipment>
}
