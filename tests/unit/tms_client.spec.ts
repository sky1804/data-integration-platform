import { test } from '@japa/runner'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import TmsClient from '../../app/integrations/tms/tms_client.js'
import {
  TmsAuthenticationError,
  TmsRateLimitError,
  TmsUnavailableError,
  TmsTimeoutError,
  TmsPayloadValidationError,
  TmsRequestError,
} from '../../app/integrations/tms/tms_errors.js'
import { createTmsMockServer } from '../../mocks/tms/server.js'

const apiKey = 'tms-test-key'
async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
async function close(server: Server) {
  const closed = once(server, 'close')
  server.close()
  server.closeAllConnections()
  await closed
}

test.group('M5 TMS HTTP boundary', (group) => {
  let server: Server
  let url: string
  group.each.setup(async () => {
    server = createTmsMockServer({ apiKey })
    url = await listen(server)
    return () => close(server)
  })

  test('uses its distinct endpoint, API key and numeric pagination contract', async ({
    assert,
  }) => {
    const requests: string[] = []
    server.on('request', (request) => {
      assert.equal(request.headers['x-api-key'], apiKey)
      assert.isUndefined(request.headers.authorization)
      requests.push(request.url!)
    })
    const client = new TmsClient({ url, apiKey, timeoutMs: 1000 })
    const first = await client.fetchPage({ page: 1, pageSize: 2 })
    assert.deepEqual(first, {
      records: [
        {
          shipmentCode: 'SHP-100',
          status: 'FINALIZADO',
          totalValue: 1250.5,
          deliveryDate: '2026-10-04',
          lastModifiedAt: '2026-10-04T13:00:00Z',
        },
        {
          shipmentCode: 'SHP-101',
          status: 'EM_TRANSITO',
          totalValue: 890,
          deliveryDate: null,
          lastModifiedAt: '2026-10-04T13:10:00Z',
        },
      ],
      currentPage: 1,
      totalPages: 2,
    })
    const second = await client.fetchPage({ page: 2, pageSize: 2 })
    assert.equal(second.currentPage, 2)
    assert.equal(second.totalPages, 2)
    assert.equal(second.records[0].shipmentCode, 'SHP-102')
    assert.equal(second.records[0].status, 'CRIADO')
    assert.deepEqual(requests, ['/shipments?page=1&pageSize=2', '/shipments?page=2&pageSize=2'])
  })

  test('fetches defaults and supports different page sizes', async ({ assert }) => {
    const client = new TmsClient({ url, apiKey, timeoutMs: 1000 })
    const first = await client.fetchPage()
    assert.equal(first.currentPage, 1)
    const ids: string[] = []
    for (let page = 1; page <= 3; page++) {
      const result = await client.fetchPage({ page, pageSize: 1 })
      assert.equal(result.totalPages, 3)
      ids.push(result.records[0].shipmentCode)
    }
    assert.deepEqual(ids, ['SHP-100', 'SHP-101', 'SHP-102'])
  })

  test('rejects wrong credentials and the mock rejects a missing API key', async ({ assert }) => {
    await assert.rejects(
      () => new TmsClient({ url, apiKey: 'wrong', timeoutMs: 1000 }).fetchPage(),
      TmsAuthenticationError
    )
    const response = await fetch(`${url}/shipments`)
    assert.equal(response.status, 401)
    await response.body?.cancel()
  })

  test('preserves additional provider fields through HTTP parsing and validation', async ({
    assert,
  }) => {
    const raw = {
      shipmentCode: 'SHP-extra',
      status: 'FINALIZADO',
      totalValue: 1250.5,
      deliveryDate: '2026-10-04',
      lastModifiedAt: '2026-10-04T13:00:00Z',
      providerSpecificField: 'value',
      metadata: { tags: ['priority'], optional: null },
    }
    server.removeAllListeners('request')
    server.on('request', (_request, response) => {
      response.end(JSON.stringify({ items: [raw], page: { current: 1, totalPages: 1 } }))
    })
    const result = await new TmsClient({ url, apiKey, timeoutMs: 1000 }).fetchPage()
    assert.deepEqual(result.records[0], raw)
    assert.notProperty(result.records[0], 'amount')
  })

  test('supports mock health and controlled scenarios independently of the client API', async ({
    assert,
  }) => {
    const health = await fetch(`${url}/health`)
    assert.deepEqual(await health.json(), { status: 'ok', service: 'tms-mock' })
    for (const [scenario, status] of [
      ['unauthorized', 401],
      ['rate-limit', 429],
      ['server-error', 500],
      ['invalid-payload', 200],
    ] as const) {
      const response = await fetch(`${url}/shipments?scenario=${scenario}`, {
        headers: { 'X-API-Key': apiKey },
      })
      assert.equal(response.status, status)
      await response.body?.cancel()
    }
  })

  test('rejects invalid request options before HTTP access', async ({ assert }) => {
    let requests = 0
    server.on('request', () => requests++)
    const client = new TmsClient({ url, apiKey, timeoutMs: 1000 })
    for (const page of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(() => client.fetchPage({ page }), TypeError)
    }
    for (const pageSize of [0, -1, 1.5, 101, Number.NaN]) {
      await assert.rejects(() => client.fetchPage({ pageSize }), TypeError)
    }
    assert.equal(requests, 0)
  })

  test('rejects invalid configuration without leaking its value', ({ assert }) => {
    for (const options of [
      { url: 'secret-invalid-url', apiKey, timeoutMs: 1000 },
      { url: 'http://user:secret@localhost', apiKey, timeoutMs: 1000 },
      { url: 'ftp://localhost', apiKey, timeoutMs: 1000 },
      { url: `${url}?scenario=slow`, apiKey, timeoutMs: 1000 },
      { url, apiKey: '', timeoutMs: 1000 },
      { url, apiKey: 'secret\r\nheader', timeoutMs: 1000 },
      { url, apiKey, timeoutMs: 0 },
      { url, apiKey, timeoutMs: 2_147_483_648 },
    ]) {
      try {
        new TmsClient(options)
        assert.fail('Expected configuration rejection')
      } catch (error) {
        assert.instanceOf(error, TypeError)
        assert.notInclude(String(error), 'secret')
        assert.notInclude(String(error), apiKey)
      }
    }
  })
})

test.group('M5 TMS failure classification', () => {
  for (const [status, ExpectedError] of [
    [401, TmsAuthenticationError],
    [403, TmsAuthenticationError],
    [429, TmsRateLimitError],
    [500, TmsUnavailableError],
    [503, TmsUnavailableError],
    [400, TmsRequestError],
    [302, TmsRequestError],
  ] as const) {
    test(`classifies HTTP ${status} without retry or secret leakage`, async ({
      assert,
      cleanup,
    }) => {
      let requests = 0
      const server = createServer((_request, response) => {
        requests++
        response.writeHead(status, { Location: 'http://127.0.0.1:1/private' })
        response.end(apiKey)
      })
      const url = await listen(server)
      cleanup(() => close(server))
      try {
        await new TmsClient({ url, apiKey, timeoutMs: 1000 }).fetchPage()
        assert.fail('Expected provider failure')
      } catch (error) {
        assert.instanceOf(error, ExpectedError)
        assert.equal((error as InstanceType<typeof ExpectedError>).httpStatus, status)
        assert.notInclude(String(error), apiKey)
      }
      assert.equal(requests, 1)
    })
  }

  test('times out a slow mock response', async ({ assert, cleanup }) => {
    const server = createTmsMockServer({ apiKey, scenario: 'slow', slowMs: 250 })
    const url = await listen(server)
    cleanup(() => close(server))
    await assert.rejects(
      () => new TmsClient({ url, apiKey, timeoutMs: 50 }).fetchPage(),
      TmsTimeoutError
    )
  })

  test('keeps the deadline active during body consumption', async ({ assert, cleanup }) => {
    const server = createServer((_request, response) => {
      response.writeHead(200)
      response.write('{"items":')
    })
    const url = await listen(server)
    cleanup(() => close(server))
    await assert.rejects(
      () => new TmsClient({ url, apiKey, timeoutMs: 50 }).fetchPage(),
      TmsTimeoutError
    )
  })

  for (const [name, body] of [
    ['invalid JSON', '{invalid'],
    ['invalid payload', JSON.stringify({ items: [{ shipmentCode: null }] })],
    ['unexpected page', JSON.stringify({ items: [], page: { current: 2, totalPages: 2 } })],
  ]) {
    test(`rejects ${name}`, async ({ assert, cleanup }) => {
      const server = createServer((_request, response) => response.end(body))
      const url = await listen(server)
      cleanup(() => close(server))
      await assert.rejects(
        () => new TmsClient({ url, apiKey, timeoutMs: 1000 }).fetchPage(),
        TmsPayloadValidationError
      )
    })
  }

  test('classifies an interrupted response as unavailable', async ({ assert, cleanup }) => {
    const server = createServer((_request, response) => response.destroy())
    const url = await listen(server)
    cleanup(() => close(server))
    await assert.rejects(
      () => new TmsClient({ url, apiKey, timeoutMs: 1000 }).fetchPage(),
      TmsUnavailableError
    )
  })
})
