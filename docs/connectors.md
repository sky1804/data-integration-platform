# Connector boundary — M5

M2 deliberately implemented one concrete Carrier client. With a second real
provider in M5, both need page retrieval, ingestion metadata and classified
failures. This is the evidence for one small Connector interface, not a plugin
framework, base HTTP client or repository hierarchy.

```text
SyncEngine → Connector.fetchPage()
                 ├─ CarrierConnector → CarrierClient → Carrier HTTP
                 └─ TmsConnector     → TmsClient     → TMS HTTP
```

## Contract and ownership

`app/integrations/connector.ts` defines:

```ts
interface SourceObservation {
  externalId: string
  sourceUpdatedAt: DateTime | null
  payload: Record<string, unknown>
}

interface ConnectorPage {
  records: SourceObservation[]
  nextCursor: string | null
}

interface Connector {
  fetchPage(options?: { cursor?: string; limit?: number }): Promise<ConnectorPage>
}
```

Clients own authentication, HTTP, timeouts, parsing, schema validation and their
provider-specific errors. Connectors adapt validated raw records to this envelope
and translate known client errors. They do not issue HTTP directly, persist data,
iterate all pages, normalize business values, reconcile, enqueue or retry.

SyncEngine owns iteration, cycle detection, page transactions, progress counters
and audit lifecycle. It consumes only envelope fields and ConnectorError kinds;
it has no Carrier/TMS field or error-class imports. The job remains an unchanged
adapter calling `execute(integrationId)`.

## Ingestion metadata is not business normalization

| Envelope field    | Carrier source                 | TMS source                      |
| ----------------- | ------------------------------ | ------------------------------- |
| `externalId`      | `shipmentId`                   | `shipmentCode`                  |
| `sourceUpdatedAt` | Luxon parse of `updatedAt`     | Luxon parse of `lastModifiedAt` |
| `payload`         | Entire original Carrier object | Entire original TMS object      |

`payload` retains the original object and all extra fields. JSONB persistence
preserves its structure. Status, amount/totalValue, delivery date and field names
remain provider-specific. Dates are parsed only for the separate ingestion
timestamp column; the date strings inside the payload are untouched.

Connectors do not convert business amounts or statuses. M6's separate
[normalizers](normalization.md) create canonical historical projections alongside
the unchanged raw SourceRecords. Reconciliation remains deferred.

## Pagination and resolution

CarrierConnector forwards cursor/limit unchanged to CarrierClient. TmsConnector
translates an absent cursor to page 1, numeric string cursor to its page number,
and limit to pageSize. It emits the next page as a string, or null after the
final page. It rejects malformed/unsafe numeric cursors before client access.
Callers treat all cursors as opaque and keep a consistent limit between pages.

`connector_factory.ts` exports `SupportedProvider = 'carrier' | 'tms'`, a shared
supported-provider predicate, and a two-case `createConnector` function. API
prevalidation and SyncEngine use the same supported set. Unknown providers still
fail before run creation, even with a test resolver injected.

```ts
const engine = new SyncEngine({
  connectorResolver: (provider) => createConnector(provider),
  pageSize: 2,
})
```

The resolver defaults to `createConnector`; tests can return a small fake
Connector. No registry, dynamic loading protocol, provider configuration table,
reflection or new dependency-injection framework exists.

## Error boundary

Each concrete connector translates known provider-specific errors into a
`ConnectorError`. It preserves an available HTTP status and uses fixed sanitized
messages, never the original body, URL, credentials or exception message.
Unknown errors propagate and become the engine's `UNEXPECTED_ERROR`.

| Carrier/TMS client error suffix | Connector kind  | SyncRun error code       |
| ------------------------------- | --------------- | ------------------------ |
| AuthenticationError             | AUTHENTICATION  | PROVIDER_AUTHENTICATION  |
| RateLimitError                  | RATE_LIMIT      | PROVIDER_RATE_LIMIT      |
| UnavailableError                | UNAVAILABLE     | PROVIDER_UNAVAILABLE     |
| TimeoutError                    | TIMEOUT         | PROVIDER_TIMEOUT         |
| PayloadValidationError          | PAYLOAD_INVALID | PROVIDER_PAYLOAD_INVALID |
| RequestError                    | REQUEST_FAILED  | PROVIDER_REQUEST_FAILED  |

The engine maps only these shared kinds to stable audit codes. Persistence,
cycle detection and finalization errors remain engine responsibilities. Existing
fail-fast behavior, counter meanings and SUCCESS/PARTIAL/FAILED rules are unchanged.

See [TMS contract](tms-provider.md), [Carrier contract](carrier-provider.md),
[engine](sync-engine.md), [asynchronous entrypoint](async-sync.md) and
[M5 validation](m5-validation.md).
