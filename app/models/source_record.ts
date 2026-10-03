import { SourceRecordSchema } from '#database/schema'
import { belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import SyncRun from '#models/sync_run'

export default class SourceRecord extends SourceRecordSchema {
  declare payload: Record<string, unknown>

  @belongsTo(() => SyncRun)
  declare syncRun: BelongsTo<typeof SyncRun>
}
