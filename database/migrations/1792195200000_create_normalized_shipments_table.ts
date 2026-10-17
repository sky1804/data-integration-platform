import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'normalized_shipments'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table
        .integer('source_record_id')
        .notNullable()
        .references('id')
        .inTable('source_records')
        .onDelete('RESTRICT')
        .unique()
      table.string('shipment_key').notNullable()
      table
        .string('status')
        .notNullable()
        .checkIn(['PENDING', 'IN_TRANSIT', 'DELIVERED', 'CANCELED', 'UNKNOWN'])
      table.decimal('amount', 15, 2).notNullable()
      table.check("amount != 'NaN'::numeric", [], 'normalized_shipments_amount_finite')
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.index('shipment_key')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
