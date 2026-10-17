import { test } from '@japa/runner'
import CarrierShipmentNormalizer from '../../app/normalization/carrier_shipment_normalizer.js'
import TmsShipmentNormalizer from '../../app/normalization/tms_shipment_normalizer.js'
import { canonicalAmount, NormalizationError } from '../../app/normalization/shipment_normalizer.js'
import { createShipmentNormalizer } from '../../app/normalization/shipment_normalizer_factory.js'

test.group('M6 shipment normalizers', () => {
  for (const [provider, mappings] of [
    [
      'carrier',
      [
        ['PENDING', 'PENDING'],
        ['IN_TRANSIT', 'IN_TRANSIT'],
        ['DELIVERED', 'DELIVERED'],
        ['CANCELED', 'CANCELED'],
        ['NEW_CARRIER_STATE', 'UNKNOWN'],
        ['toString', 'UNKNOWN'],
      ],
    ],
    [
      'tms',
      [
        ['CRIADO', 'PENDING'],
        ['EM_TRANSITO', 'IN_TRANSIT'],
        ['FINALIZADO', 'DELIVERED'],
        ['CANCELADO', 'CANCELED'],
        ['EM_SEPARACAO', 'UNKNOWN'],
        ['__proto__', 'UNKNOWN'],
      ],
    ],
  ] as const) {
    for (const [rawStatus, status] of mappings) {
      test(`${provider} maps ${rawStatus} to ${status} without mutating raw data`, ({ assert }) => {
        const payload = Object.freeze(
          provider === 'carrier'
            ? {
                shipmentId: ' SHP-100 ',
                status: rawStatus,
                amount: 1250.5,
                extra: { untouched: true },
              }
            : {
                shipmentCode: ' SHP-100 ',
                status: rawStatus,
                totalValue: 1250.5,
                deliveryDate: '2026-10-04',
                extra: { untouched: true },
              }
        )
        const before = structuredClone(payload)
        const normalizer = createShipmentNormalizer(provider)
        assert.deepEqual(
          normalizer.normalize({ externalId: 'source-id', sourceUpdatedAt: null, payload }),
          {
            shipmentKey: ' SHP-100 ',
            status,
            amount: '1250.50',
          }
        )
        assert.deepEqual(payload, before)
      })
    }
  }

  for (const [input, expected] of [
    [0, '0.00'],
    [-0, '0.00'],
    [0.01, '0.01'],
    [0.1, '0.10'],
    [890, '890.00'],
    [-1250.5, '-1250.50'],
    [9999999999999.99, '9999999999999.99'],
    [-9999999999999.99, '-9999999999999.99'],
  ] as const) {
    test(`represents ${Object.is(input, -0) ? '-0' : input} as ${expected}`, ({ assert }) => {
      assert.strictEqual(canonicalAmount(input), expected)
    })
  }

  for (const input of [
    1.001,
    1.005,
    0.1 + 0.2,
    1e-7,
    1e13,
    -1e13,
    Number.MAX_VALUE,
    Infinity,
    -Infinity,
    Number.NaN,
  ]) {
    test(`rejects unrepresentable amount ${input} without rounding or leaking it`, ({ assert }) => {
      assert.throws(
        () => canonicalAmount(input),
        NormalizationError,
        'Provider amount cannot be represented as a canonical shipment value'
      )
    })
  }

  test('uses only the two shared supported provider cases', ({ assert }) => {
    assert.instanceOf(createShipmentNormalizer('carrier'), CarrierShipmentNormalizer)
    assert.instanceOf(createShipmentNormalizer('tms'), TmsShipmentNormalizer)
  })

  test('different raw schemas can yield equivalent canonical values', ({ assert }) => {
    const carrier = new CarrierShipmentNormalizer().normalize({
      externalId: 'SHP-100',
      sourceUpdatedAt: null,
      payload: { shipmentId: 'SHP-100', status: 'DELIVERED', amount: 1250.5 },
    })
    const tms = new TmsShipmentNormalizer().normalize({
      externalId: 'SHP-100',
      sourceUpdatedAt: null,
      payload: { shipmentCode: 'SHP-100', status: 'FINALIZADO', totalValue: 1250.5 },
    })
    assert.deepEqual(carrier, tms)
  })
})
