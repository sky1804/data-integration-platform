import { SourceRecordSchema } from '#database/schema'
import { belongsTo, hasOne } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasOne } from '@adonisjs/lucid/types/relations'
import SyncRun from '#models/sync_run'
import NormalizedShipment from '#models/normalized_shipment'

export default class SourceRecord extends SourceRecordSchema {
  declare payload: Record<string, unknown>

  @belongsTo(() => SyncRun)
  declare syncRun: BelongsTo<typeof SyncRun>

  @hasOne(() => NormalizedShipment)
  declare normalizedShipment: HasOne<typeof NormalizedShipment>
}
