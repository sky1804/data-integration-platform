import { SyncRunSchema } from '#database/schema'
import { belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import Integration from '#models/integration'
import SourceRecord from '#models/source_record'

export default class SyncRun extends SyncRunSchema {
  declare status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED'

  @belongsTo(() => Integration)
  declare integration: BelongsTo<typeof Integration>

  @hasMany(() => SourceRecord)
  declare sourceRecords: HasMany<typeof SourceRecord>
}
