import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('reconciliation_runs', (table) => {
      table.increments('id')
      table
        .integer('carrier_sync_run_id')
        .notNullable()
        .references('id')
        .inTable('sync_runs')
        .onDelete('RESTRICT')
      table
        .integer('tms_sync_run_id')
        .notNullable()
        .references('id')
        .inTable('sync_runs')
        .onDelete('RESTRICT')
      table.string('status').notNullable().checkIn(['PENDING', 'RUNNING', 'SUCCESS', 'FAILED'])
      for (const field of [
        'carrier_records',
        'tms_records',
        'compared_records',
        'discrepancies_found',
      ]) {
        table.integer(field).notNullable().defaultTo(0)
        table.check(`${field} >= 0`, [], `reconciliation_runs_${field}_nonnegative`)
      }
      table.timestamp('started_at', { useTz: true }).nullable()
      table.timestamp('finished_at', { useTz: true }).nullable()
      table.string('error_code').nullable()
      table.text('error_message').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
      table.check(
        'carrier_sync_run_id <> tms_sync_run_id',
        [],
        'reconciliation_runs_distinct_sources'
      )
      table.check(
        'compared_records <= carrier_records AND compared_records <= tms_records',
        [],
        'reconciliation_runs_compared_bounds'
      )
      table.index('carrier_sync_run_id')
      table.index('tms_sync_run_id')
    })
    this.schema.createTable('discrepancies', (table) => {
      table.increments('id')
      table
        .integer('reconciliation_run_id')
        .notNullable()
        .references('id')
        .inTable('reconciliation_runs')
        .onDelete('RESTRICT')
      table.string('shipment_key').notNullable()
      table
        .string('type')
        .notNullable()
        .checkIn(['STATUS_MISMATCH', 'VALUE_MISMATCH', 'MISSING_IN_CARRIER', 'MISSING_IN_TMS'])
      table
        .integer('carrier_normalized_shipment_id')
        .nullable()
        .references('id')
        .inTable('normalized_shipments')
        .onDelete('RESTRICT')
      table
        .integer('tms_normalized_shipment_id')
        .nullable()
        .references('id')
        .inTable('normalized_shipments')
        .onDelete('RESTRICT')
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.check(
        `
        (type IN ('STATUS_MISMATCH', 'VALUE_MISMATCH') AND carrier_normalized_shipment_id IS NOT NULL AND tms_normalized_shipment_id IS NOT NULL)
        OR (type = 'MISSING_IN_CARRIER' AND carrier_normalized_shipment_id IS NULL AND tms_normalized_shipment_id IS NOT NULL)
        OR (type = 'MISSING_IN_TMS' AND carrier_normalized_shipment_id IS NOT NULL AND tms_normalized_shipment_id IS NULL)
      `,
        [],
        'discrepancies_reference_shape'
      )
      table.unique(['reconciliation_run_id', 'shipment_key', 'type'])
      table.index('shipment_key')
    })
  }

  async down() {
    this.schema.dropTable('discrepancies')
    this.schema.dropTable('reconciliation_runs')
  }
}
