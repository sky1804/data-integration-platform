# Carrier provider — M2

M2 implements HTTP communication only. `CarrierClient` does not import Lucid,
create synchronization records, normalize values, enqueue jobs, or retry. M3 will
decide how to iterate pages and persist observations. There is no shared connector
interface while only one provider exists.

## Contract and configuration

`GET /shipments?cursor=page-2&limit=2` requires `Authorization: Bearer <token>`.
The response is `{ data: CarrierShipment[], pagination: { nextCursor: string | null } }`.
Each shipment contains `shipmentId: string`, `status: string`, `amount: number`,
and `updatedAt: string`. Statuses and all additional fields remain raw provider
values. The deterministic demo contains SHP-100, SHP-101, and SHP-102.

| Variable                 | Meaning                                                           | Example                                 |
| ------------------------ | ----------------------------------------------------------------- | --------------------------------------- |
| `CARRIER_API_URL`        | HTTP(S) base URL without embedded credentials, query, or fragment | `http://127.0.0.1:4001`                 |
| `CARRIER_API_TOKEN`      | Required secret Bearer token                                      | `carrier-demo-token` (public demo only) |
| `CARRIER_API_TIMEOUT_MS` | Positive integer milliseconds, maximum 2147483647                 | `3000`                                  |

Adonis validates these values at startup in `start/env.ts`. `config/carrier.ts`
holds configuration; the token uses the framework's `Secret` wrapper until the
client constructs the request. Compose overrides the URL with
`http://carrier-mock:4001` for both API and worker. Local Node development uses
the published localhost port. Keep tokens out of URLs and logs.

## Client API and pagination

```ts
import CarrierClient from './app/integrations/carrier/carrier_client.js'

const client = new CarrierClient()
const first = await client.fetchPage({ limit: 2 })
if (first.nextCursor !== null) {
  const second = await client.fetchPage({ cursor: first.nextCursor, limit: 2 })
  // second.records contains SHP-102; second.nextCursor is null.
}
```

The constructor optionally accepts `{ url, token, timeoutMs }`, allowing local
HTTP test servers without changing production configuration. `fetchPage` accepts
only `cursor?: string` and `limit?: number`, returning
`{ records: CarrierShipment[], nextCursor: string | null }`. Limits are integers
from 1 to 100; omission lets the provider choose its default (2 in the mock).
Treat cursors as opaque and keep the same limit between pages. The mock's
`page-N` cursor identifies a page within its fixed dataset. No automatic loop or
`fetchAllShipments` method exists. Query parameters use `URLSearchParams`.

Native Node.js 24 `fetch` and `AbortSignal.timeout` cover the request and response
body consumption. Redirects are rejected instead of following another endpoint.
Each call makes one request; no retry or backoff is implemented.

## Validation and errors

A small dedicated validator treats parsed JSON as `unknown`. It requires an
array of object records, nonblank shipment IDs, string statuses, finite numeric
amounts, and ISO timestamps with seconds and an explicit timezone. Existing
Luxon validates calendar dates; impossible dates and timestamps without a timezone
are rejected. Pagination and a string or null `nextCursor` are required. Empty
pages are valid. Records retain their original timestamps, statuses, and extra
fields. One invalid record rejects the whole page.

| Condition                                        | Error                           |
| ------------------------------------------------ | ------------------------------- |
| HTTP 401 / 403                                   | `CarrierAuthenticationError`    |
| HTTP 429                                         | `CarrierRateLimitError`         |
| HTTP 5xx or network/stream failure               | `CarrierUnavailableError`       |
| Deadline exceeded, including during body reading | `CarrierTimeoutError`           |
| HTTP 200 invalid JSON or invalid payload         | `CarrierPayloadValidationError` |
| Other HTTP statuses, including redirects         | `CarrierRequestError`           |

Errors extend `CarrierError`, exposing `httpStatus` when a provider response
exists. Messages identify the category or invalid field and omit tokens, URLs,
response values/bodies, and low-level exception details. Invalid constructor or
page options produce `TypeError` before a request is sent.

## Mock and manual checks

`mocks/carrier/server.ts` uses Node's HTTP server and native TypeScript execution;
its image has no npm dependencies. It runs as the `node` user, receives only a
demo token and delay setting, and has no database/Redis configuration, clients,
or volumes. `GET /health` is unauthenticated and returns
`{ "status": "ok", "service": "carrier-mock" }`. Compose checks it with native
`fetch`. Application startup waits only for PostgreSQL and Redis, so a provider
outage does not block unrelated API/worker startup.

```sh
docker compose up --build -d
curl http://127.0.0.1:4001/health
curl -H 'Authorization: Bearer carrier-demo-token' 'http://127.0.0.1:4001/shipments?limit=2'
curl -H 'Authorization: Bearer carrier-demo-token' 'http://127.0.0.1:4001/shipments?cursor=page-2&limit=2'
curl http://127.0.0.1:4001/shipments
curl -H 'Authorization: Bearer carrier-demo-token' 'http://127.0.0.1:4001/shipments?scenario=rate-limit'
```

PowerShell users can use `curl.exe`. Substitute your configured mock token.
The mock supports development/test query scenarios:

| Scenario           | Behavior                                            |
| ------------------ | --------------------------------------------------- |
| `normal` (default) | Deterministic paginated HTTP 200                    |
| `unauthorized`     | HTTP 401 even with the demo token                   |
| `rate-limit`       | HTTP 429                                            |
| `server-error`     | HTTP 500                                            |
| `invalid-payload`  | HTTP 200 with invalid fields and missing pagination |
| `slow`             | Delayed response, 5000 ms by default                |

Actual authentication precedes scenario selection. Unknown scenarios, invalid
limits, and invalid cursors return HTTP 400. `CARRIER_MOCK_SLOW_MS` controls the
mock-only delay; keep it greater than the client timeout to exercise timeouts.
Scenario controls are absent from the production client API.

Carrier unit tests run against ephemeral local HTTP servers:

```sh
node ace test unit
```

They need neither running database/Redis services nor Compose. The full suite
still needs the isolated test database for M0/M1 functional tests.

References: [AdonisJS configuration and environment](https://docs.adonisjs.com/configuration)
and [Node.js 24 globals](https://nodejs.org/docs/latest-v24.x/api/globals.html).
