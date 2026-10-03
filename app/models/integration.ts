import { IntegrationSchema } from '#database/schema'
import { hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'
import SyncRun from '#models/sync_run'

export default class Integration extends IntegrationSchema {
  @hasMany(() => SyncRun)
  declare syncRuns: HasMany<typeof SyncRun>
}
