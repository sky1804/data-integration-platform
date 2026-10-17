import { NormalizedShipmentSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import SourceRecord from '#models/source_record'
import type { CanonicalShipmentStatus } from '../normalization/shipment_normalizer.js'

export default class NormalizedShipment extends NormalizedShipmentSchema {
  declare status: CanonicalShipmentStatus

  @belongsTo(() => SourceRecord)
  declare sourceRecord: BelongsTo<typeof SourceRecord>
}
