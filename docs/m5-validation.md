# M5 — completion and validation

Validation date: 2026-10-16 (America/Sao_Paulo). Inspected clean `main` at
`9d335d0`, existing engine/client/job/controller, installed package versions,
tests, environment validation and Compose before changes. Local Node.js 24.11.1,
npm 11.6.4, Docker Linux containers. Existing dependency versions and lockfile
were retained, including pinned Queue 0.6.2.

## Files

Created:

- `app/integrations/connector.ts`: SourceObservation, page/options and minimal Connector interface.
- `app/integrations/connector_errors.ts`: six shared failure kinds and sanitized error.
- `app/integrations/connector_factory.ts`: SupportedProvider type, supported predicate and two-case resolver.
- `app/integrations/carrier/carrier_connector.ts`: Carrier metadata/error adaptation.
- `app/integrations/tms/tms_client.ts`, `tms_types.ts`, `tms_validator.ts`,
  `tms_errors.ts`, `tms_connector.ts`: concrete TMS HTTP boundary and adapter.
- `config/tms.ts`: validated URL, Secret API key and timeout.
- `mocks/tms/server.ts` and `mocks/tms/Dockerfile`: separate deterministic provider.
- `tests/unit/tms_client.spec.ts`, `tms_validator.spec.ts`, `connectors.spec.ts`.
- `tests/functional/tms_sync.spec.ts`: real HTTP/connector/PostgreSQL execution.
- `docs/connectors.md`, `docs/tms-provider.md`, and this validation record.

Modified:

- `app/services/sync_engine.ts`: consume Connector observations/errors and inject a resolver.
- `app/controllers/integration_syncs_controller.ts`: shared supported-provider predicate.
- `app/integrations/carrier/carrier_types.ts`: formalize extra raw fields with Record<string, unknown>.
- `start/env.ts`, `.env.example` and ignored local `.env`: TMS URL/key/deadline.
- `compose.yaml`: sixth service, internal TMS URL, localhost port, health check and isolated provider network.
- `tests/functional/sync_engine.spec.ts`: preserve all 24 behaviors using Connector injection;
  real Carrier regression now goes through CarrierConnector.
- `tests/functional/integration_syncs.spec.ts`: also accept TMS; unknown-provider rejection retained.
- `tests/functional/sync_integration_job.spec.ts`: execute TMS through the same generic job.
- `tests/manual/async_sync.mjs`: both real providers and raw-schema comparison, retaining M4 checks.
- `README.md`, `docs/sync-engine.md`, `docs/async-sync.md`,
  `docs/carrier-provider.md`, `docs/sync-lifecycle.md`: current architecture and usage.

CarrierClient's HTTP implementation, validator/errors/mock and existing M2 tests
are unchanged. SyncIntegrationJob and its integrationId-only payload are unchanged.
No schema, models, migrations, Queue/Redis configuration, worker concurrency,
scheduler, application Dockerfile, dependencies or lockfile changed.

## Architectural decisions

Only the shared Connector abstraction was introduced after implementing the
second concrete provider. It has one fetchPage method returning observations and
an opaque next cursor. Each observation carries externalId, a Luxon/null source
timestamp and a complete raw payload. It does not carry normalized business data.

CarrierConnector maps shipmentId/updatedAt; TmsConnector maps
shipmentCode/lastModifiedAt. Both retain raw object identity and additional fields.
TMS status FINALIZADO, totalValue and deliveryDate remain unchanged. There is no
shared business status/amount mapping, canonical Shipment or normalized table.

Clients retain all HTTP responsibilities. TMS uses X-API-Key and page/pageSize,
unlike Carrier's Bearer/cursor contract. Its connector hides that difference by
mapping opaque numeric-string cursors to page numbers. The TMS client validates
returned page metadata and rejects a page number that differs from the request.
Neither provider retries.

Known client errors translate to ConnectorError AUTHENTICATION, RATE_LIMIT,
UNAVAILABLE, TIMEOUT, PAYLOAD_INVALID or REQUEST_FAILED. SyncEngine maps only
these shared kinds to the existing PROVIDER_* audit codes and fixed messages.
Unknown failures retain UNEXPECTED_ERROR behavior. It imports no provider client,
provider error class or raw shipment field.

The small factory and predicate support only carrier/tms. Unknown providers still
fail before run creation. Engine injection is now
`new SyncEngine({ connectorResolver: () => connector, pageSize })`; its public
execute(integrationId) method and all lifecycle/transaction/counter rules remain.

The endpoint accepts both providers and dispatches the same integrationId-only
job. The worker reloads Integration and resolves its current provider, preventing
payload/configuration disagreement. Existing zero-retry, no-deduplication and
concurrent-run semantics remain intact.

The TMS mock is a native Node.js 24 process with only its own key and mock delay.
It receives no application .env, secrets, DB/Redis credentials or volumes. A
provider network shared only with API/worker separates it from PostgreSQL/Redis.
Its health check does not gate application startup. No new npm library was needed.

See [connectors](connectors.md) and [TMS provider](tms-provider.md) for exact contracts.

## Tests and regression strategy

All 24 original M3 behavior tests retain their assertions. Their fixtures now
produce SourceObservations and shared errors; unsupported provider uses an actual
unknown value instead of the newly supported tms. Transactions, duplicate-page
rollback, committed progress visibility, counters, failures, cycles, history,
concurrent executions and finalization failures continue to pass.

New coverage:

- 20 TMS HTTP tests: endpoint/header, defaults and page sizes, both pages/final
  page, missing/invalid credentials, 401/403/429/500/503, redirects/unexpected
  statuses, invalid JSON/schema/page number, slow headers/body, stream failure,
  input/config validation, raw extra fields and mock scenarios.
- 35 TMS validator tests: raw identity, unknown fields, nullable dates, timezone
  timestamps, calendar/offset/time overflow, amount finiteness, required fields
  and safe valid pagination.
- 18 connector tests: exact metadata and raw payloads, opaque pagination,
  all twelve provider-error translations, unknown-error propagation, invalid
  TMS cursors and two-provider resolution.
- Four TMS engine tests: multi-page SUCCESS with three exact raw records,
  first-page authentication FAILED, later HTTP 500 PARTIAL preserving the first
  page, and engine-owned cycle protection for a TMS integration.
- One additional endpoint test: TMS HTTP 202 with only integrationId in the job,
  real package job ID and no dispatch-time SyncRun/SourceRecords.
- One additional worker test: the unchanged job executes a TMS integration and
  creates SUCCESS/raw TMS records with zero retries.

These add 79 tests to the prior 108. Existing Carrier/M0/M1 tests are unchanged.
Queue fakes and original worker-manager state are restored after tests. Functional
groups keep the existing guarded PostgreSQL `_test` database strategies; no
development data is used. Provider unit tests use ephemeral local HTTP servers.

## Real asynchronous validation

`npm run test:async` retains the M4 isolation/cleanup design: its own timestamped
test database, disposable Redis, random localhost API port and separate workers.
No shared Redis flush or production/development writes occur.

Observed:

1. Carrier HTTP POST returns 202 with a real Redis pending job while no test worker
   exists. There is no SyncRun or SourceRecord yet.
2. The standard worker consumes it through CarrierConnector and creates SUCCESS
   with three raw Carrier SourceRecords.
3. A TMS integration POST uses the same endpoint, payload and worker/job. Its job
   completes, creating a second SUCCESS run with three raw TMS SourceRecords.
4. For SHP-100, Carrier retains shipmentId/status IN_TRANSIT/amount/updatedAt;
   TMS retains shipmentCode/status FINALIZADO/totalValue/deliveryDate/lastModifiedAt.
   The records have distinct run IDs and structurally different payloads. No
   business normalization or reconciliation occurs.
5. The M4 invalid-Carrier-credentials check still yields an HTTP 202 followed by
   a failed queue job and FAILED/PROVIDER_AUTHENTICATION audit, with no retry.
6. Stopping only the disposable Redis still yields sanitized HTTP 503 and no new
   run. Its test database contains three runs and six source records before cleanup.
7. Owned test containers/database are removed. Shared Redis is untouched, the
   regular test schema contains only migration metadata after cleanup, and all
   development domain tables remain at zero rows before/after validation.

## Commands executed

```sh
git status --short
git branch --show-current
git log -2 --oneline
npm ls @adonisjs/core @adonisjs/queue @adonisjs/lucid --depth=0
docker compose up -d postgres redis carrier-mock tms-mock
node ace test unit
npm test
npm run test:async
npm run lint
npm run typecheck
npm run format:check
npm run build
docker compose config --quiet
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail 5 api worker tms-mock
git diff --check
```

Local functional tests used process-local PORT=3334. Formatted all new/modified
files with Prettier. PostgreSQL counts, test-schema cleanup and disposable
database absence were inspected through `docker compose exec -T postgres psql`.
Native assertions inside the API container checked all health endpoints and
rejected empty TMS key, non-HTTP URL and zero timeout. Docker network inspection
confirmed no shared TMS/PostgreSQL/Redis network. TMS process environment inspection
confirmed no DB_, REDIS_, CARRIER_ or APP_ settings, without printing key values.

## Results

| Check                                              | Result                                                |
| -------------------------------------------------- | ----------------------------------------------------- |
| M0 / M1                                            | Passed: 3 / 17 tests                                  |
| M2 Carrier boundary                                | Passed: 46 tests                                      |
| M3 behavioral regression through Connector         | Passed: 24 tests                                      |
| M4 regression                                      | Passed: 18 tests                                      |
| M5 additions                                       | Passed: 79 tests                                      |
| Full suite                                         | Passed: 187/187                                       |
| Real HTTP/Redis/worker for both providers          | Passed; SUCCESS with three raw records each           |
| Different raw payloads for same external ID        | Confirmed; provider-specific fields/statuses retained |
| TMS FAILED / PARTIAL and cycle behavior            | Passed; counters and earlier commits preserved        |
| M4 failure, zero retry and queue outage regression | Passed                                                |
| Lint, typecheck, formatting                        | Passed                                                |
| Production application / Docker build              | Passed                                                |
| Default / development Compose configuration        | Passed                                                |
| API / worker                                       | Running; generic job discovered and consumed          |
| PostgreSQL / Redis / both mock providers           | Healthy; all health/connection checks passed          |
| TMS configuration validation                       | Invalid key/URL/timeout rejected                      |
| TMS secret/network isolation                       | Confirmed                                             |
| Development database / shared Redis                | Unchanged by validation                               |
| Disposable validation resources                    | Cleaned up                                            |

## Issues and remaining tradeoffs

Docker was initially stopped; starting installed Docker Desktop enabled checks.
The first immediate PostgreSQL inspection occurred during startup; it was repeated
after the service became healthy. One initial test lint finding was corrected by
assigning the awaited result before reading its member. No schema or package
upgrade was required, and no unresolved M5 implementation failure remains.

Earlier limitations remain: unauthenticated dispatch, concurrent duplicate runs,
no queue-to-run durable linkage, crash recovery and unbounded distinct-cursor
sequences. TMS page cursors assume a stable dataset/page size; no snapshot/resume
semantics are introduced. Concrete clients intentionally remain separate rather
than adding a generic HTTP inheritance layer.

Existing dependency findings remain; production dependency installation still
reports 13 high-rated affected entries. The lockfile was retained; see the dated
[dependency security review](dependency-security.md). M4's Redis outage latency
and nonfatal route-type generation warning in test-mode production containers
remain documented in its validation record.

No M6 functionality was implemented: no business normalization, canonical status
or amount, Shipment model, normalized table, reconciliation or discrepancies.
No new retry/backoff, locks, scheduler, authentication, frontend or CI/CD was added.
