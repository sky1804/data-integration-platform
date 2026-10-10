import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const shipments = [
  {
    shipmentId: 'SHP-100',
    status: 'IN_TRANSIT',
    amount: 1250.5,
    updatedAt: '2026-10-04T12:00:00Z',
  },
  { shipmentId: 'SHP-101', status: 'DELIVERED', amount: 890, updatedAt: '2026-10-04T12:10:00Z' },
  { shipmentId: 'SHP-102', status: 'PENDING', amount: 3500.25, updatedAt: '2026-10-04T12:20:00Z' },
]

interface MockOptions {
  token: string
  scenario?: string
  slowMs?: number
}

export function createCarrierMockServer({
  token,
  scenario = 'normal',
  slowMs = 5000,
}: MockOptions) {
  if (!token.trim()) throw new Error('Carrier mock requires a token')
  if (!Number.isInteger(slowMs) || slowMs < 1)
    throw new Error('Carrier mock delay must be positive')
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://carrier-mock')
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(200, { status: 'ok', service: 'carrier-mock' })
    }
    if (request.method !== 'GET' || url.pathname !== '/shipments') {
      return send(404, { error: 'not_found' })
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      return send(401, { error: 'unauthorized' })
    }
    const selected = url.searchParams.get('scenario') ?? scenario
    if (selected === 'unauthorized') return send(401, { error: 'unauthorized' })
    if (selected === 'rate-limit') return send(429, { error: 'rate_limited' })
    if (selected === 'server-error') return send(500, { error: 'unavailable' })
    if (selected === 'invalid-payload') {
      return send(200, {
        data: [
          { shipmentId: null, status: 'DELIVERED', amount: 'invalid', updatedAt: 'not-a-date' },
        ],
      })
    }
    if (!['normal', 'slow'].includes(selected)) return send(400, { error: 'invalid_scenario' })
    const limitValue = url.searchParams.get('limit') ?? '2'
    if (!/^\d+$/.test(limitValue) || Number(limitValue) < 1 || Number(limitValue) > 100) {
      return send(400, { error: 'invalid_limit' })
    }
    const limit = Number(limitValue)
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null && (!/^page-[1-9]\d*$/.test(cursor) || Number(cursor.slice(5)) < 2)) {
      return send(400, { error: 'invalid_cursor' })
    }
    const page = cursor === null ? 1 : Number(cursor.slice(5))
    const offset = (page - 1) * limit
    if (!Number.isSafeInteger(offset) || offset >= shipments.length) {
      return send(400, { error: 'invalid_cursor' })
    }
    const body = {
      data: shipments.slice(offset, offset + limit),
      pagination: { nextCursor: offset + limit < shipments.length ? `page-${page + 1}` : null },
    }
    if (selected === 'slow') {
      const timer = setTimeout(() => send(200, body), slowMs)
      response.once('close', () => clearTimeout(timer))
      return
    }
    send(200, body)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.CARRIER_API_TOKEN
  if (!token) throw new Error('CARRIER_API_TOKEN is required')
  const server = createCarrierMockServer({
    token,
    slowMs: Number(process.env.CARRIER_MOCK_SLOW_MS ?? 5000),
  })
  server.listen(4001, '0.0.0.0', () => console.log('Carrier mock listening on port 4001'))
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      server.close()
      server.closeAllConnections()
    })
  }
}
