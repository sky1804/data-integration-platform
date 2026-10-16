import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import CarrierConnector from '../../app/integrations/carrier/carrier_connector.js'
import TmsConnector from '../../app/integrations/tms/tms_connector.js'
import { ConnectorError } from '../../app/integrations/connector_errors.js'
import { createConnector, isSupportedProvider } from '../../app/integrations/connector_factory.js'
import {
  CarrierAuthenticationError,
  CarrierRateLimitError,
  CarrierUnavailableError,
  CarrierTimeoutError,
  CarrierPayloadValidationError,
  CarrierRequestError,
} from '../../app/integrations/carrier/carrier_errors.js'
import {
  TmsAuthenticationError,
  TmsRateLimitError,
  TmsUnavailableError,
  TmsTimeoutError,
  TmsPayloadValidationError,
  TmsRequestError,
} from '../../app/integrations/tms/tms_errors.js'

test.group('M5 connectors', () => {
  test('Carrier maps only ingestion metadata and preserves raw object identity', async ({
    assert,
  }) => {
    const raw = {
      shipmentId: 'SHP-100',
      status: 'DELIVERED',
      amount: 1250.5,
      updatedAt: '2026-10-04T12:00:00Z',
      extra: { fragile: true },
    }
    const connector = new CarrierConnector({
      async fetchPage(options) {
        assert.deepEqual(options, { cursor: 'opaque&cursor', limit: 2 })
        return { records: [raw], nextCursor: 'next' }
      },
    })
    const page = await connector.fetchPage({ cursor: 'opaque&cursor', limit: 2 })
    assert.strictEqual(page.records[0].payload, raw)
    assert.equal(page.records[0].externalId, raw.shipmentId)
    assert.equal(
      page.records[0].sourceUpdatedAt!.toMillis(),
      DateTime.fromISO(raw.updatedAt).toMillis()
    )
    assert.equal(page.records[0].payload.status, 'DELIVERED')
    assert.equal(page.nextCursor, 'next')
    assert.notProperty(raw, 'externalId')
  })

  test('TMS maps numeric pages into opaque cursors without business normalization', async ({
    assert,
  }) => {
    const raw = {
      shipmentCode: 'SHP-100',
      status: 'FINALIZADO',
      totalValue: 1250.5,
      deliveryDate: '2026-10-04',
      lastModifiedAt: '2026-10-04T13:00:00Z',
      extra: { tags: ['priority'] },
    }
    const requested: unknown[] = []
    const connector = new TmsConnector({
      async fetchPage(options) {
        requested.push(options)
        return { records: [raw], currentPage: options!.page!, totalPages: 2 }
      },
    })
    const first = await connector.fetchPage({ limit: 2 })
    assert.equal(first.nextCursor, '2')
    const second = await connector.fetchPage({ cursor: first.nextCursor!, limit: 2 })
    assert.isNull(second.nextCursor)
    assert.deepEqual(requested, [
      { page: 1, pageSize: 2 },
      { page: 2, pageSize: 2 },
    ])
    assert.strictEqual(first.records[0].payload, raw)
    assert.equal(first.records[0].externalId, raw.shipmentCode)
    assert.equal(
      first.records[0].sourceUpdatedAt!.toMillis(),
      DateTime.fromISO(raw.lastModifiedAt).toMillis()
    )
    assert.equal(first.records[0].payload.status, 'FINALIZADO')
    assert.equal(first.records[0].payload.totalValue, 1250.5)
    assert.equal(first.records[0].payload.deliveryDate, '2026-10-04')
    assert.notProperty(first.records[0].payload, 'amount')
    assert.notProperty(first.records[0].payload, 'shipmentId')
  })

  for (const [ConnectorClass, errors] of [
    [
      CarrierConnector,
      [
        CarrierAuthenticationError,
        CarrierRateLimitError,
        CarrierUnavailableError,
        CarrierTimeoutError,
        CarrierPayloadValidationError,
        CarrierRequestError,
      ],
    ],
    [
      TmsConnector,
      [
        TmsAuthenticationError,
        TmsRateLimitError,
        TmsUnavailableError,
        TmsTimeoutError,
        TmsPayloadValidationError,
        TmsRequestError,
      ],
    ],
  ] as const) {
    const kinds = [
      'AUTHENTICATION',
      'RATE_LIMIT',
      'UNAVAILABLE',
      'TIMEOUT',
      'PAYLOAD_INVALID',
      'REQUEST_FAILED',
    ] as const
    for (const [index, ErrorClass] of errors.entries()) {
      test(`${ConnectorClass.name} translates ${ErrorClass.name} to ${kinds[index]}`, async ({
        assert,
      }) => {
        const connector = new ConnectorClass({
          async fetchPage() {
            throw new ErrorClass('secret-key Bearer token provider-body https://private', 403)
          },
        })
        try {
          await connector.fetchPage()
          assert.fail('Expected connector error')
        } catch (error) {
          assert.instanceOf(error, ConnectorError)
          assert.equal((error as ConnectorError).kind, kinds[index])
          assert.equal((error as ConnectorError).httpStatus, 403)
          assert.notMatch(String(error), /secret|token|Bearer|provider-body|private/)
        }
      })
    }
    test(`${ConnectorClass.name} does not disguise unexpected programming errors`, async ({
      assert,
    }) => {
      const unexpected = new Error('unexpected')
      const connector = new ConnectorClass({
        async fetchPage() {
          throw unexpected
        },
      })
      try {
        await connector.fetchPage()
        assert.fail('Expected original error')
      } catch (error) {
        assert.strictEqual(error, unexpected)
      }
    })
  }

  test('TMS rejects malformed cursor before calling its client', async ({ assert }) => {
    let requests = 0
    const connector = new TmsConnector({
      async fetchPage() {
        requests++
        return { records: [], currentPage: 1, totalPages: 1 }
      },
    })
    for (const cursor of ['', '0', '-1', '2&scenario=slow', '1.5', '9007199254740993']) {
      await assert.rejects(() => connector.fetchPage({ cursor }), ConnectorError)
    }
    assert.equal(requests, 0)
  })

  test('resolves only the two explicitly supported providers', ({ assert }) => {
    assert.instanceOf(createConnector('carrier'), CarrierConnector)
    assert.instanceOf(createConnector('tms'), TmsConnector)
    assert.isTrue(isSupportedProvider('carrier'))
    assert.isTrue(isSupportedProvider('tms'))
    assert.isFalse(isSupportedProvider('unknown-provider'))
  })
})
