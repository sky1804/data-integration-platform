import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'sync_runs'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table
        .integer('integration_id')
        .notNullable()
        .references('id')
        .inTable('integrations')
        .onDelete('RESTRICT')
      table
        .string('status')
        .notNullable()
        .checkIn(['PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED'])
      table.timestamp('started_at', { useTz: true }).nullable()
      table.timestamp('finished_at', { useTz: true }).nullable()
      table.integer('records_received').notNullable().defaultTo(0)
      table.integer('records_persisted').notNullable().defaultTo(0)
      table.integer('records_failed').notNullable().defaultTo(0)
      table.string('error_code').nullable()
      table.text('error_message').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
      table.index('integration_id')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
