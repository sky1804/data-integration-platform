import { test } from '@japa/runner'
import { validateCarrierPage } from '../../app/integrations/carrier/carrier_validator.js'
import { CarrierPayloadValidationError } from '../../app/integrations/carrier/carrier_errors.js'

const shipment = {
  shipmentId: 'SHP-100',
  status: 'CARRIER_CUSTOM_STATUS',
  amount: 1250.5,
  updatedAt: '2026-10-04T12:00:00Z',
  metadata: { fragile: true },
}
const page = { data: [shipment], pagination: { nextCursor: null } }

test.group('Carrier payload validation', () => {
  test('preserves raw fields, provider status, timestamp and extra fields', ({ assert }) => {
    const result = validateCarrierPage(page)
    assert.strictEqual(result.records[0], shipment)
    assert.isNull(result.nextCursor)
  })

  test('accepts an empty final page and timezone offsets', ({ assert }) => {
    assert.deepEqual(validateCarrierPage({ data: [], pagination: { nextCursor: null } }), {
      records: [],
      nextCursor: null,
    })
    const raw = { ...shipment, updatedAt: '2026-10-04T09:00:00.123-03:00' }
    assert.equal(
      validateCarrierPage({ data: [raw], pagination: { nextCursor: 'opaque' } }).records[0]
        .updatedAt,
      raw.updatedAt
    )
  })

  for (const [description, payload] of [
    ['null response', null],
    ['array response', []],
    ['missing data', { pagination: { nextCursor: null } }],
    ['non-array data', { ...page, data: {} }],
    ['missing pagination', { data: [] }],
    ['null pagination', { data: [], pagination: null }],
    ['missing next cursor', { data: [], pagination: {} }],
    ['numeric cursor', { data: [], pagination: { nextCursor: 2 } }],
    ['null record', { ...page, data: [null] }],
    ['null ID', { ...page, data: [{ ...shipment, shipmentId: null }] }],
    ['blank ID', { ...page, data: [{ ...shipment, shipmentId: '   ' }] }],
    ['non-string status', { ...page, data: [{ ...shipment, status: 1 }] }],
    ['string amount', { ...page, data: [{ ...shipment, amount: '1250.5' }] }],
    ['infinite amount', { ...page, data: [{ ...shipment, amount: Infinity }] }],
    ['NaN amount', { ...page, data: [{ ...shipment, amount: Number.NaN }] }],
    ['invalid date', { ...page, data: [{ ...shipment, updatedAt: 'not-a-date' }] }],
    [
      'invalid offset',
      { ...page, data: [{ ...shipment, updatedAt: '2026-10-04T12:00:00+99:99' }] },
    ],
    [
      'invalid offset minutes',
      { ...page, data: [{ ...shipment, updatedAt: '2026-10-04T12:00:00-03:99' }] },
    ],
    ['invalid hour', { ...page, data: [{ ...shipment, updatedAt: '2026-10-04T24:00:00Z' }] }],
    ['calendar overflow', { ...page, data: [{ ...shipment, updatedAt: '2026-02-30T12:00:00Z' }] }],
    ['date without time', { ...page, data: [{ ...shipment, updatedAt: '2026-10-04' }] }],
    [
      'timestamp without timezone',
      { ...page, data: [{ ...shipment, updatedAt: '2026-10-04T12:00:00' }] },
    ],
    ['invalid later record', { ...page, data: [shipment, { ...shipment, amount: null }] }],
  ] as const) {
    test(`rejects ${description}`, ({ assert }) => {
      assert.throws(() => validateCarrierPage(payload), CarrierPayloadValidationError)
    })
  }
})
