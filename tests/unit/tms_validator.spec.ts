import { test } from '@japa/runner'
import { validateTmsPage } from '../../app/integrations/tms/tms_validator.js'
import { TmsPayloadValidationError } from '../../app/integrations/tms/tms_errors.js'

const raw = {
  shipmentCode: 'SHP-100',
  status: 'FINALIZADO',
  totalValue: 1250.5,
  deliveryDate: '2026-10-04',
  lastModifiedAt: '2026-10-04T13:00:00Z',
  metadata: { tags: ['priority'], optional: null },
}
const valid = { items: [raw], page: { current: 1, totalPages: 2 } }

test.group('M5 TMS payload validation', () => {
  test('preserves the complete original object and accepts nullable delivery dates', ({
    assert,
  }) => {
    assert.strictEqual(validateTmsPage(valid).records[0], raw)
    const record = { ...raw, deliveryDate: null, lastModifiedAt: '2026-10-04T10:00:00.123-03:00' }
    assert.strictEqual(validateTmsPage({ ...valid, items: [record] }).records[0], record)
    assert.deepEqual(validateTmsPage({ items: [], page: { current: 1, totalPages: 1 } }), {
      records: [],
      currentPage: 1,
      totalPages: 1,
    })
  })

  for (const [field, value] of [
    ['shipmentCode', null],
    ['shipmentCode', '   '],
    ['status', 1],
    ['totalValue', '1250.5'],
    ['totalValue', Infinity],
    ['totalValue', Number.NaN],
    ['deliveryDate', undefined],
    ['deliveryDate', '2026-02-30'],
    ['deliveryDate', '2026-10-04T00:00:00Z'],
    ['deliveryDate', '2026-1-4'],
    ['lastModifiedAt', null],
    ['lastModifiedAt', '2026-10-04'],
    ['lastModifiedAt', '2026-10-04T13:00:00'],
    ['lastModifiedAt', '2026-02-30T13:00:00Z'],
    ['lastModifiedAt', '2026-10-04T24:00:00Z'],
    ['lastModifiedAt', '2026-10-04T13:00:00+99:99'],
    ['lastModifiedAt', '2026-10-04T13:60:00Z'],
  ] as const) {
    test(`rejects invalid ${field}: ${String(value)}`, ({ assert }) => {
      assert.throws(
        () => validateTmsPage({ ...valid, items: [raw, { ...raw, [field]: value }] }),
        TmsPayloadValidationError
      )
    })
  }

  for (const [name, payload] of [
    ['null response', null],
    ['array response', []],
    ['missing items', { page: valid.page }],
    ['non-array items', { ...valid, items: {} }],
    ['null record', { ...valid, items: [null] }],
    ['missing page', { items: [] }],
    ['null page', { ...valid, page: null }],
    ['missing current', { ...valid, page: { totalPages: 2 } }],
    ['zero current', { ...valid, page: { current: 0, totalPages: 2 } }],
    ['fractional current', { ...valid, page: { current: 1.5, totalPages: 2 } }],
    ['string current', { ...valid, page: { current: '1', totalPages: 2 } }],
    ['missing total', { ...valid, page: { current: 1 } }],
    ['zero total', { ...valid, page: { current: 1, totalPages: 0 } }],
    ['fractional total', { ...valid, page: { current: 1, totalPages: 2.5 } }],
    ['infinite total', { ...valid, page: { current: 1, totalPages: Infinity } }],
    ['unsafe total', { ...valid, page: { current: 1, totalPages: Number.MAX_SAFE_INTEGER + 1 } }],
    ['current beyond total', { ...valid, page: { current: 3, totalPages: 2 } }],
  ] as const) {
    test(`rejects ${name}`, ({ assert }) => {
      assert.throws(() => validateTmsPage(payload), TmsPayloadValidationError)
    })
  }
})
