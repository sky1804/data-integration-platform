import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const shipments = [
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
  {
    shipmentCode: 'SHP-102',
    status: 'CRIADO',
    totalValue: 3500.25,
    deliveryDate: null,
    lastModifiedAt: '2026-10-04T13:20:00Z',
  },
]

interface MockOptions {
  apiKey: string
  scenario?: string
  slowMs?: number
}

export function createTmsMockServer({ apiKey, scenario = 'normal', slowMs = 5000 }: MockOptions) {
  if (!apiKey.trim()) throw new Error('TMS mock requires an API key')
  if (!Number.isInteger(slowMs) || slowMs < 1) throw new Error('TMS mock delay must be positive')
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://tms-mock')
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (request.method === 'GET' && url.pathname === '/health')
      return send(200, { status: 'ok', service: 'tms-mock' })
    if (request.method !== 'GET' || url.pathname !== '/shipments')
      return send(404, { error: 'not_found' })
    if (request.headers['x-api-key'] !== apiKey) return send(401, { error: 'unauthorized' })
    const selected = url.searchParams.get('scenario') ?? scenario
    if (selected === 'unauthorized') return send(401, { error: 'unauthorized' })
    if (selected === 'rate-limit') return send(429, { error: 'rate_limited' })
    if (selected === 'server-error') return send(500, { error: 'unavailable' })
    if (selected === 'invalid-payload')
      return send(200, { items: [{ shipmentCode: null, totalValue: 'invalid' }] })
    if (!['normal', 'slow'].includes(selected)) return send(400, { error: 'invalid_scenario' })
    const pageValue = url.searchParams.get('page') ?? '1'
    const sizeValue = url.searchParams.get('pageSize') ?? '2'
    const current = Number(pageValue)
    const pageSize = Number(sizeValue)
    if (
      !/^[1-9]\d*$/.test(pageValue) ||
      !Number.isSafeInteger(current) ||
      !/^[1-9]\d*$/.test(sizeValue) ||
      pageSize > 100
    )
      return send(400, { error: 'invalid_pagination' })
    const totalPages = Math.ceil(shipments.length / pageSize)
    if (current > totalPages) return send(400, { error: 'invalid_page' })
    const body = {
      items: shipments.slice((current - 1) * pageSize, current * pageSize),
      page: { current, totalPages },
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
  const apiKey = process.env.TMS_API_KEY
  if (!apiKey) throw new Error('TMS_API_KEY is required')
  const server = createTmsMockServer({
    apiKey,
    slowMs: Number(process.env.TMS_MOCK_SLOW_MS ?? 5000),
  })
  server.listen(4002, '0.0.0.0', () => console.log('TMS mock listening on port 4002'))
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      server.close()
      server.closeAllConnections()
    })
  }
}
