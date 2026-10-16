# TMS provider — M5

TMS intentionally uses a different HTTP/raw-data contract from Carrier. Its
client and connector do not depend on Lucid, queues or business normalization.

## HTTP contract

```http
GET /shipments?page=1&pageSize=2
X-API-Key: tms-demo-key
```

```json
{
  "items": [
    {
      "shipmentCode": "SHP-100",
      "status": "FINALIZADO",
      "totalValue": 1250.5,
      "deliveryDate": "2026-10-04",
      "lastModifiedAt": "2026-10-04T13:00:00Z"
    }
  ],
  "page": { "current": 1, "totalPages": 2 }
}
```

This shows one record's shape; the deterministic mock's first page at size 2
contains SHP-100 and SHP-101, and its second contains SHP-102. Statuses are
FINALIZADO, EM_TRANSITO and CRIADO. Fields and values remain raw.

`TmsClient.fetchPage({ page?, pageSize? })` defaults to page 1/size 2 and returns
`{ records: TmsShipment[], currentPage, totalPages }`. Page is a positive safe
integer and pageSize is an integer from 1 to 100. Native fetch sends X-API-Key,
rejects redirects and applies an AbortSignal deadline through body consumption.
Each call issues one request; no retry is implemented.

The client validates the response as unknown: items must be an array of objects,
shipmentCode nonblank, status a string, totalValue finite, deliveryDate null or a
valid YYYY-MM-DD calendar date, and lastModifiedAt a valid timestamp with seconds
and explicit timezone. Numeric time/offset bounds and Luxon calendar validation
reject overflow. Page numbers must be positive safe integers, current cannot
exceed totalPages, and returned current must match the requested page. Invalid
JSON/schema produces a predictable payload error. Unknown extra record fields
are retained.

## Errors and connector

| Condition                              | Client error              |
| -------------------------------------- | ------------------------- |
| HTTP 401 / 403                         | TmsAuthenticationError    |
| HTTP 429                               | TmsRateLimitError         |
| HTTP 5xx or network/stream failure     | TmsUnavailableError       |
| Deadline exceeded                      | TmsTimeoutError           |
| HTTP 200 invalid JSON/payload/page     | TmsPayloadValidationError |
| Other HTTP status, including redirects | TmsRequestError           |

Errors extend TmsError, with HTTP status when available and no sensitive response
body/URL/key in their messages. Invalid constructor/request options fail before
HTTP access. The production client exposes no mock-scenario option.

TmsConnector converts opaque cursor `undefined` to page 1 and cursor `"2"` to page 2. It maps shipmentCode/lastModifiedAt to ingestion metadata while preserving the
complete payload object. Known client failures cross the shared ConnectorError
boundary described in [connectors.md](connectors.md).

## Configuration and mock

| Variable           | Example / purpose                                         |
| ------------------ | --------------------------------------------------------- |
| TMS_API_URL        | `http://127.0.0.1:4002`; validated HTTP(S) base URL       |
| TMS_API_KEY        | `tms-demo-key`; required Adonis Secret                    |
| TMS_API_TIMEOUT_MS | `3000`; positive integer milliseconds, maximum 2147483647 |

Adonis validates these in start/env.ts, with config/tms.ts holding runtime
settings. Existing local .env files need the three new values from .env.example.
Compose overrides the URL for API/worker to `http://tms-mock:4002`.

The lightweight Node.js 24 mock has no npm dependencies, runs as the node user,
and receives only its own demo API key and mock delay. It has no application
environment file, database/Redis credentials, clients or volumes. Its dedicated
provider network is shared with API/worker, not PostgreSQL/Redis. Startup of the
application remains independent of external mock health.

`GET /health` requires no key and returns
`{ "status": "ok", "service": "tms-mock" }`. Compose checks it with native fetch.
The published port is localhost-only.

| Mock query scenario | Behavior                                              |
| ------------------- | ----------------------------------------------------- |
| normal (default)    | Deterministic page/pageSize response                  |
| unauthorized        | HTTP 401                                              |
| rate-limit          | HTTP 429                                              |
| server-error        | HTTP 500                                              |
| invalid-payload     | HTTP 200 malformed data                               |
| slow                | Response delayed by TMS_MOCK_SLOW_MS, default 5000 ms |

Authentication is checked before scenario selection. Unknown scenarios and invalid
pagination return 400. Keep the mock delay above the client deadline when testing
timeouts. Scenario controls belong only to the mock and test fixtures.

```sh
docker compose up --build -d
curl http://127.0.0.1:4002/health
curl -H 'X-API-Key: tms-demo-key' 'http://127.0.0.1:4002/shipments?page=1&pageSize=2'
curl -H 'X-API-Key: tms-demo-key' 'http://127.0.0.1:4002/shipments?page=2&pageSize=2'
curl -H 'X-API-Key: tms-demo-key' 'http://127.0.0.1:4002/shipments?scenario=rate-limit'
node ace test unit
npm run test:async
```

Use curl.exe on PowerShell if needed and substitute your configured demo key.
Unit tests use ephemeral HTTP servers. The isolated Docker validation exercises
both providers through the existing HTTP/Redis/worker path and verifies that
their raw observations for SHP-100 remain structurally different.
