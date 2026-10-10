import { test } from '@japa/runner'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import CarrierClient from '../../app/integrations/carrier/carrier_client.js'
import {
  CarrierAuthenticationError,
  CarrierRateLimitError,
  CarrierUnavailableError,
  CarrierTimeoutError,
  CarrierPayloadValidationError,
  CarrierRequestError,
} from '../../app/integrations/carrier/carrier_errors.js'
import { createCarrierMockServer } from '../../mocks/carrier/server.js'

const token = 'carrier-test-token'

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

test.group('Carrier HTTP boundary', (group) => {
  let server: Server
  let url: string
  group.each.setup(async () => {
    server = createCarrierMockServer({ token })
    url = await listen(server)
    return () => close(server)
  })

  test('sends the endpoint, Bearer token and page parameters; keeps raw provider data', async ({
    assert,
  }) => {
    const requests: string[] = []
    server.on('request', (request) => {
      requests.push(request.url!)
      assert.equal(request.headers.authorization, `Bearer ${token}`)
      assert.equal(request.headers.accept, 'application/json')
    })
    const client = new CarrierClient({ url, token, timeoutMs: 1000 })
    const first = await client.fetchPage({ limit: 2 })
    assert.deepEqual(first, {
      records: [
        {
          shipmentId: 'SHP-100',
          status: 'IN_TRANSIT',
          amount: 1250.5,
          updatedAt: '2026-10-04T12:00:00Z',
        },
        {
          shipmentId: 'SHP-101',
          status: 'DELIVERED',
          amount: 890,
          updatedAt: '2026-10-04T12:10:00Z',
        },
      ],
      nextCursor: 'page-2',
    })
    assert.isNotNull(first.nextCursor)
    const second = await client.fetchPage({ cursor: first.nextCursor!, limit: 2 })
    assert.deepEqual(second, {
      records: [
        {
          shipmentId: 'SHP-102',
          status: 'PENDING',
          amount: 3500.25,
          updatedAt: '2026-10-04T12:20:00Z',
        },
      ],
      nextCursor: null,
    })
    assert.deepEqual(requests, ['/shipments?limit=2', '/shipments?cursor=page-2&limit=2'])
  })

  test('fetches the default first page', async ({ assert }) => {
    const page = await new CarrierClient({ url, token, timeoutMs: 1000 }).fetchPage()
    assert.lengthOf(page.records, 2)
    assert.equal(page.nextCursor, 'page-2')
  })

  test('paginates with a smaller page size', async ({ assert }) => {
    const client = new CarrierClient({ url, token, timeoutMs: 1000 })
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const page = await client.fetchPage({ cursor: cursor ?? undefined, limit: 1 })
      ids.push(...page.records.map((record) => record.shipmentId))
      cursor = page.nextCursor
    } while (cursor !== null)
    assert.deepEqual(ids, ['SHP-100', 'SHP-101', 'SHP-102'])
  })

  test('classifies invalid credentials and rejects missing credentials at the mock', async ({
    assert,
  }) => {
    const client = new CarrierClient({ url, token: 'invalid', timeoutMs: 1000 })
    try {
      await client.fetchPage()
      assert.fail('Expected authentication error')
    } catch (error) {
      assert.instanceOf(error, CarrierAuthenticationError)
      assert.equal((error as CarrierAuthenticationError).httpStatus, 401)
      assert.notInclude(String(error), token)
    }
    const response = await fetch(`${url}/shipments`)
    assert.equal(response.status, 401)
    await response.body?.cancel()
  })

  test('provides health without provider authentication', async ({ assert }) => {
    const response = await fetch(`${url}/health`)
    assert.deepEqual(await response.json(), { status: 'ok', service: 'carrier-mock' })
  })

  test('rejects invalid request options before making a request', async ({ assert }) => {
    let count = 0
    server.on('request', () => count++)
    const client = new CarrierClient({ url, token, timeoutMs: 1000 })
    for (const limit of [0, -1, 1.5, 101, Number.NaN, Infinity]) {
      await assert.rejects(() => client.fetchPage({ limit }), TypeError)
    }
    await assert.rejects(() => client.fetchPage({ cursor: '' }), TypeError)
    assert.equal(count, 0)
  })

  test('keeps mock failure scenarios behind the mock query parameter', async ({ assert }) => {
    for (const [scenario, status] of [
      ['unauthorized', 401],
      ['rate-limit', 429],
      ['server-error', 500],
      ['invalid-payload', 200],
    ] as const) {
      const response = await fetch(`${url}/shipments?scenario=${scenario}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(response.status, status)
      await response.body?.cancel()
    }
  })

  test('rejects invalid configuration without leaking configured values', ({ assert }) => {
    for (const options of [
      { url: 'invalid-sensitive-url', token, timeoutMs: 1000 },
      { url: 'http://user:private@localhost', token, timeoutMs: 1000 },
      { url: 'ftp://localhost', token, timeoutMs: 1000 },
      { url: `${url}?scenario=slow`, token, timeoutMs: 1000 },
      { url, token: '', timeoutMs: 1000 },
      { url, token: 'private\r\nheader', timeoutMs: 1000 },
      { url, token, timeoutMs: 0 },
      { url, token, timeoutMs: 1.5 },
      { url, token, timeoutMs: 2_147_483_648 },
    ]) {
      try {
        new CarrierClient(options)
        assert.fail('Expected invalid configuration error')
      } catch (error) {
        assert.instanceOf(error, TypeError)
        assert.notInclude(String(error), 'private')
        assert.notInclude(String(error), 'sensitive')
        assert.notInclude(String(error), token)
      }
    }
  })
})

test.group('Carrier controlled failures', () => {
  for (const [scenario, ExpectedError, status] of [
    ['unauthorized', CarrierAuthenticationError, 401],
    ['rate-limit', CarrierRateLimitError, 429],
    ['server-error', CarrierUnavailableError, 500],
    ['invalid-payload', CarrierPayloadValidationError, 200],
    ['slow', CarrierTimeoutError, undefined],
  ] as const) {
    test(`classifies ${scenario} without retries`, async ({ assert, cleanup }) => {
      const server = createCarrierMockServer({ token, scenario, slowMs: 200 })
      const url = await listen(server)
      cleanup(() => close(server))
      let requests = 0
      server.on('request', () => requests++)
      const client = new CarrierClient({ url, token, timeoutMs: scenario === 'slow' ? 50 : 1000 })
      try {
        await client.fetchPage()
        assert.fail('Expected provider error')
      } catch (error) {
        assert.instanceOf(error, ExpectedError)
        assert.equal((error as InstanceType<typeof ExpectedError>).httpStatus, status)
        assert.notInclude(String(error), token)
      }
      assert.equal(requests, 1)
    })
  }

  for (const [status, ExpectedError] of [
    [403, CarrierAuthenticationError],
    [503, CarrierUnavailableError],
    [400, CarrierRequestError],
    [302, CarrierRequestError],
  ] as const) {
    test(`classifies HTTP ${status} without exposing the body or following redirects`, async ({
      assert,
      cleanup,
    }) => {
      const server = createServer((_request, response) => {
        response.writeHead(status, { Location: 'http://127.0.0.1:1/leaked' })
        response.end(`sensitive: ${token}`)
      })
      const url = await listen(server)
      cleanup(() => close(server))
      try {
        await new CarrierClient({ url, token, timeoutMs: 1000 }).fetchPage()
        assert.fail('Expected provider error')
      } catch (error) {
        assert.instanceOf(error, ExpectedError)
        assert.equal((error as InstanceType<typeof ExpectedError>).httpStatus, status)
        assert.notInclude(String(error), token)
      }
    })
  }

  test('classifies malformed JSON', async ({ assert, cleanup }) => {
    const server = createServer((_request, response) => response.end('{broken JSON'))
    const url = await listen(server)
    cleanup(() => close(server))
    await assert.rejects(
      () => new CarrierClient({ url, token, timeoutMs: 1000 }).fetchPage(),
      CarrierPayloadValidationError
    )
  })

  test('applies the timeout while reading the response body', async ({ assert, cleanup }) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{"data":')
    })
    const url = await listen(server)
    cleanup(() => close(server))
    await assert.rejects(
      () => new CarrierClient({ url, token, timeoutMs: 50 }).fetchPage(),
      CarrierTimeoutError
    )
  })

  test('classifies an interrupted response as unavailable', async ({ assert, cleanup }) => {
    const server = createServer((_request, response) => response.destroy())
    const url = await listen(server)
    cleanup(() => close(server))
    await assert.rejects(
      () => new CarrierClient({ url, token, timeoutMs: 1000 }).fetchPage(),
      CarrierUnavailableError
    )
  })

  test('encodes an opaque cursor as a single query parameter', async ({ assert, cleanup }) => {
    const cursor = 'opaque+cursor&scenario=server-error/?'
    const server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://carrier')
      assert.equal(url.searchParams.get('cursor'), cursor)
      assert.isNull(url.searchParams.get('scenario'))
      response.end(JSON.stringify({ data: [], pagination: { nextCursor: null } }))
    })
    const url = await listen(server)
    cleanup(() => close(server))
    const page = await new CarrierClient({ url, token, timeoutMs: 1000 }).fetchPage({ cursor })
    assert.deepEqual(page, { records: [], nextCursor: null })
  })
})
