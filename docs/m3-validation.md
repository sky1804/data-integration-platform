# M3 — completion and validation

Validation date: 2026-10-14 (America/Sao_Paulo). Inspected clean `main` at
`d158511`, installed dependencies, M1 models/schema/migrations, M2 client/mock,
existing tests, environment validation, database configuration and Docker setup
before editing. Local Node.js 24.11.1 / npm 11.6.4; Docker Linux containers.

## Files and scope

Created:

- `app/services/sync_engine.ts`: direct synchronous execution, page iteration,
  transactional raw persistence, counters, cycle protection and finalization.
- `app/services/sync_engine_errors.ts`: precondition, execution and finalization
  errors with stable codes and sanitized messages.
- `tests/functional/sync_engine.spec.ts`: 24 PostgreSQL functional tests.
- `docs/sync-engine.md`: public API, lifecycle, persistence/error semantics and tradeoffs.
- `docs/m3-validation.md`: this validation record.

Modified:

- `README.md`: M3 overview, direct execution documentation link and test isolation.
- `docs/sync-lifecycle.md`: service-enforced transitions, terminal meanings and M3 cleanup.
- `docs/carrier-provider.md`: link to the service that now owns iteration/persistence.

No changes to models, migrations, generated schema, CarrierClient/mock, API routes,
environment variables, package versions, lockfile, Dockerfile or Compose services.
Existing Queue 0.6.2 remains pinned. No dependencies or architecture layers added.

## Decisions and execution semantics

`new SyncEngine({ carrierClient?, pageSize? }).execute(integrationId)` returns a
refreshed successful SyncRun. Default page size is 100, allowed range 1–100.
Tests substitute only the existing client's `fetchPage` method using its TypeScript
shape, without a shared connector or provider registry.

Missing/disabled/unsupported integrations are rejected before run creation or
provider requests. Only `carrier` is supported. Every valid execution persists a
new PENDING run, explicitly saves RUNNING with `startedAt`, and eventually saves
SUCCESS/PARTIAL/FAILED with `finishedAt`. PostgreSQL still checks membership only;
the service enforces transition order for executions through this entrypoint.

The engine starts without a cursor, requests one page at a time, and stops at
null. It rejects a previously requested cursor before making another request.
There is no retry, checkpoint, resume, fetch-all method or global page bound.

Each page uses a Lucid managed transaction and explicit transaction clients for
all SourceRecord writes and its progress-counter update. Carrier requests happen
outside the transaction. Raw JSON objects retain all fields; shipmentId maps to
externalId and updatedAt maps to a separate Luxon timestamp column. Duplicate
external IDs trigger the existing database constraint and roll back the entire
page. Earlier commits remain. No duplicate is skipped or overwritten.

Received counts records actually returned by CarrierClient. Persisted counts
committed SourceRecords. Failed counts every returned record in a rolled-back
page. A failed HTTP request/rejected payload adds no artificial failed records.
Finalized counters satisfy `received = persisted + failed`.

SUCCESS requires processing the final page, including empty results. A terminal
error produces PARTIAL only when at least one SourceRecord was committed;
otherwise it produces FAILED. Processing stops on the first error. After saving
the audit row, the engine throws SyncExecutionError with code and runId.

Carrier errors map respectively to PROVIDER_AUTHENTICATION, PROVIDER_RATE_LIMIT,
PROVIDER_UNAVAILABLE, PROVIDER_TIMEOUT, PROVIDER_PAYLOAD_INVALID and
PROVIDER_REQUEST_FAILED. Other codes are PERSISTENCE_ERROR, PAGINATION_CYCLE and
UNEXPECTED_ERROR. Messages are fixed sanitized descriptions, not caught error
messages. If terminal write/readback fails, SyncFinalizationError exposes
RUN_FINALIZATION_ERROR and the run ID without claiming finalization succeeded.

See [SyncEngine](sync-engine.md) for the exact API, mappings and limitations.

## Test isolation and coverage

The M3 group uses `testUtils.db().truncate()` with cleanup after each test,
allowing actual independent transaction commits. Existing M1 groups keep their
global transaction/rollback helpers unchanged. Functional suite migration/reset,
the `_test` suffix and distinct-database guards remain unchanged. No test cleanup
or synchronization writes target development data.

The 24 new tests cover:

- Multi-page success, RUNNING state before HTTP access, committed progress visible
  to another transaction before the next page, final counters and timestamps.
- Complete raw JSON, extra fields, statuses and source timestamp mapping.
- Real CarrierClient → ephemeral mock HTTP server → PostgreSQL integration.
- Separate historical runs with changed provider state and preserved earlier payload.
- Empty success and failure after an empty page.
- All six Carrier error categories plus unexpected failure, sanitized messages,
  finalized FAILED rows and exactly one request before fail-fast termination.
- Provider failure after a committed page, preserving rows with PARTIAL and 2/2/0.
- Duplicate-page rollback both with and without earlier commits; all page rows
  disappear on failure, received/failed counts include the full rejected page.
- Duplicate IDs across pages preserve the earlier committed observation.
- Missing/disabled/unsupported integration rejection without new runs.
- Longer pagination cycles with FAILED and PARTIAL outcomes and no repeated request.
- Independent concurrent runs through the same engine instance.
- Invalid page-size rejection and explicit finalization failure reporting.

## Commands and validation results

Commands executed from the project root:

```sh
git status --short
git branch --show-current
git log -4 --oneline
node --version
npm ls @adonisjs/core @adonisjs/lucid @adonisjs/queue --depth=0
docker compose up -d postgres redis carrier-mock
node ace test functional --files='tests/functional/sync_engine.spec.ts'
npm test
npm run lint
npm run typecheck
npm run format:check
npm run build
docker compose config --quiet
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose up --build -d
docker compose ps
docker compose logs --tail 6 api worker carrier-mock
docker compose exec -T redis redis-cli ping
```

Used process-local `PORT=3334` for tests to avoid the Compose API port.
Applied Prettier to new/modified files. Inspected PostgreSQL counts using
`docker compose exec -T postgres psql` before and after execution.

Also validated the compiled service inside the production API image, with
`NODE_ENV=test` selecting only the guarded isolated database:

```sh
docker compose exec -T -e NODE_ENV=test api node ace.js migration:run --force --no-schema-generate
docker compose exec -T -e NODE_ENV=test api node --input-type=module -
docker compose exec -T -e NODE_ENV=test api node ace.js migration:reset --force --no-schema-generate
```

The stdin script booted the compiled application with Ignitor, asserted
`current_database() = data_integration_test`, and invoked SyncEngine directly.
Two normal runs used the actual Compose Carrier service through its configured
URL; an invalid token caused an actual HTTP authentication failure. A later-page
unavailability error after a real first page verified PARTIAL. SQL inspection
confirmed the stored outcomes below, then the disposable test schema was reset:

| Execution                     | Status  | Received | Persisted | Failed | Stored rows |
| ----------------------------- | ------- | -------- | --------- | ------ | ----------- |
| Normal Carrier run            | SUCCESS | 3        | 3         | 0      | 3           |
| Second historical run         | SUCCESS | 3        | 3         | 0      | 3           |
| Invalid Carrier token         | FAILED  | 0        | 0         | 0      | 0           |
| Failure after real first page | PARTIAL | 2        | 2         | 0      | 2           |

| Validation                                          | Result                                                   |
| --------------------------------------------------- | -------------------------------------------------------- |
| M0 tests                                            | Passed: 3/3                                              |
| M1 tests                                            | Passed: 17/17                                            |
| M2 tests                                            | Passed: 46/46                                            |
| M3 tests                                            | Passed: 24/24                                            |
| Full test suite                                     | Passed: 90/90                                            |
| Lint, typecheck, formatting                         | Passed                                                   |
| Production application build                        | Passed                                                   |
| Production Docker build                             | Passed through Compose production target                 |
| Default and development Compose configuration       | Passed                                                   |
| API/worker startup                                  | Running; API JSON HTTP 200, separate queue worker active |
| PostgreSQL, Redis, Carrier mock                     | Healthy; Redis PONG; mock health JSON valid              |
| Compiled engine + Compose Carrier + test PostgreSQL | Passed; success, failure, partial, history verified      |
| Test cleanup                                        | Only Lucid migration metadata tables remain              |
| Development database isolation                      | All three domain tables stayed at zero rows before/after |

## Issues and tradeoffs

Docker was initially stopped; starting installed Docker Desktop enabled all
container checks. One initial lint finding in a test was corrected by assigning
the awaited query result before accessing its payload. No blocking M3 defect
required changing M1 schema or the M2 boundary.

Concurrent executions remain independent and may both observe the same shipment.
There is no lock or cross-run deduplication. A process crash or database outage
can leave a RUNNING row or an uncertain commit/finalization result; automatic
recovery is deferred. Provider sequences with endlessly distinct cursors are not
bounded. Sequential per-record inserts favor clear transactional semantics over
bulk-write optimization in this milestone.

Existing no-jobs startup warnings remain expected. Dependency installation still
reports 17 high-rated affected entries in the full graph and 13 in production;
M3 retains the existing lockfile and adds no packages. See the dated
[dependency security review](dependency-security.md).

No Queue/M4 functionality was implemented: no jobs, dispatch, synchronization
HTTP endpoints, scheduler, retry/backoff, locks, TMS, generic connector,
normalization, reconciliation, frontend or CI/CD.

References consulted: [Lucid transactions](https://lucid.adonisjs.com/docs/transactions),
[Lucid testing utilities](https://lucid.adonisjs.com/docs/testing), and
[AdonisJS application lifecycle](https://docs.adonisjs.com/guides/concepts/application-lifecycle).
