import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'source_records'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table
        .integer('sync_run_id')
        .notNullable()
        .references('id')
        .inTable('sync_runs')
        .onDelete('RESTRICT')
      table.string('external_id').notNullable()
      table.jsonb('payload').notNullable()
      table.timestamp('source_updated_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.unique(['sync_run_id', 'external_id'])
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
