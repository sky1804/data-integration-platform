import { ReconciliationRunSchema } from '#database/schema'
import { belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import SyncRun from '#models/sync_run'
import Discrepancy from '#models/discrepancy'

export default class ReconciliationRun extends ReconciliationRunSchema {
  declare status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED'

  @belongsTo(() => SyncRun, { foreignKey: 'carrierSyncRunId' })
  declare carrierSyncRun: BelongsTo<typeof SyncRun>

  @belongsTo(() => SyncRun, { foreignKey: 'tmsSyncRunId' })
  declare tmsSyncRun: BelongsTo<typeof SyncRun>

  @hasMany(() => Discrepancy)
  declare discrepancies: HasMany<typeof Discrepancy>
}
