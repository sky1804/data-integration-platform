# M7 — completion and validation

Validation date: 2026-10-17 (America/Sao_Paulo). Started at `b17d9f6` with no tracked
changes and a user-provided untracked `docs/milestones/m7-reconciliation.md`.
Read AGENTS, that milestone, directly relevant architecture, models, migrations,
test isolation, and installed Lucid transaction/schema declarations. Node.js
24.11.1, npm 11.6.4, Docker Linux containers. No new dependency was needed.

## Files created

- `database/migrations/1792281600000_create_reconciliation_tables.ts`: one cohesive
  migration creates reconciliation_runs followed by discrepancies; down drops
  them in reverse dependency order without modifying existing observations.
- `app/models/reconciliation_run.ts`: historical audit model with narrowed status
  and carrierSyncRun/tmsSyncRun/discrepancies relationships.
- `app/models/discrepancy.ts`: four-type model and nullable provider observation
  references, plus its reconciliationRun relationship.
- `app/services/reconciliation_engine.ts`: explicit historical comparison and
  atomic result persistence.
- `app/services/reconciliation_engine_errors.ts`: sanitized precondition,
  execution, and finalization errors.
- `tests/functional/reconciliation.spec.ts`: 77 new functional/database tests.
- `docs/reconciliation.md` and this validation record.

## Files modified

- `database/schema.ts`: regenerated using Lucid schema:generate, never manually.
- `tests/functional/normalization.spec.ts`: its M6 migration lifecycle test now
  rolls back the dependent M7 tables before dropping the normalized table, and
  restores them in cleanup. All original M6 assertions are retained.
- `tests/manual/async_sync.mjs`: retains all M4–M6 assertions and explicitly calls
  the compiled M7 service after the two real asynchronous syncs; verifies no
  automatic reconciliation occurred before the call.
- `README.md`, `docs/normalization.md`, `docs/sync-engine.md`, and
  `docs/sync-lifecycle.md`: concise current architecture and usage links.
- `docs/roadmap.md`: M7 complete and M8 next after validation.
- User-provided `docs/milestones/m7-reconciliation.md`: scope retained, formatted,
  and completion status linked to design/evidence.

Existing M0–M6 validation documents are unchanged. SyncEngine, SyncIntegrationJob,
provider clients/connectors/mocks, normalization behavior, controllers/routes,
dependencies, lockfile, Dockerfile and Compose configuration are unchanged.

## Persistence and public API

`new ReconciliationEngine().execute({ carrierSyncRunId, tmsSyncRunId })` returns
a refreshed successful ReconciliationRun. There is no automatic selection of
latest runs, HTTP endpoint, reconciliation job, or scheduler behavior.

ReconciliationRun stores the explicit source IDs, status, four counters,
started_at/finished_at, error_code/error_message, and created_at/updated_at.
It belongsTo each selected SyncRun and hasMany discrepancies. Discrepancy stores
reconciliation_run_id, shipment_key, type, nullable Carrier/TMS normalized row
IDs, and created_at. It belongsTo the run and the referenced observations, which
lead back through SourceRecord/SyncRun/Integration. It copies no raw/canonical
payloads or business values.

Database constraints enforce required references/fields, ON DELETE RESTRICT,
PENDING/RUNNING/SUCCESS/FAILED audit statuses, the four discrepancy types,
nonnegative counters, compared-record bounds, distinct source runs, and the exact
null-side combinations for missing versus mismatched records. A unique constraint
on reconciliation_run_id/shipment_key/type permits two different mismatch types
while preventing duplicate types for one key. Source-run FK indexes and a shipment
key index support known historical/provenance access. No unique source-pair
constraint is added; repeat comparisons create independent audit runs.

## Comparison, preconditions, and lifecycle

IDs must be positive PostgreSQL integers and distinct. Selected runs must exist,
be SUCCESS, and have the expected carrier/tms Integration provider roles. Every
source observation must have a normalized projection, and canonical keys must be
unique within each selected dataset. Empty successful datasets are valid. All
preconditions are checked in one REPEATABLE READ snapshot before audit creation,
with no explicit row locks. Raw payloads are neither loaded nor inspected by the
reconciliation algorithm.

Precondition codes: INVALID_SYNC_RUN_ID, SYNC_RUN_NOT_FOUND,
SYNC_RUN_NOT_SUCCESS, INVALID_PROVIDER_PAIR, INCOMPLETE_NORMALIZATION,
DUPLICATE_SHIPMENT_KEY. Rejected requests create no ReconciliationRun or
Discrepancy. Input database/audit-creation failures use PERSISTENCE_ERROR without
claiming that an audit row exists.

Matching uses exact shipmentKey string equality, including case, spaces, and
leading zeros. Canonical status and numeric(15,2) amount strings are compared
exactly. UNKNOWN equals UNKNOWN and differs from known statuses. There is no
floating-point amount conversion, tolerance, date comparison, or raw-field rule.

Only TMS present yields MISSING_IN_CARRIER; only Carrier present yields
MISSING_IN_TMS. A shared key can produce STATUS_MISMATCH, VALUE_MISMATCH, or both.
Exact matches create no row. Persistence order is deterministic JavaScript UTF-16
key order, with status before value mismatch for the same key.

carrierRecords/tmsRecords count selected canonical observations. comparedRecords
counts shared keys; discrepanciesFound counts committed discrepancy rows. For
Carrier A/B/C and TMS A/B/D, with A exact and B wrong in both values, these counters
are 3/3/2/4. Failed outputs retain known input counts and zero output counters.

Valid execution persists PENDING, then RUNNING with startedAt. One result
transaction inserts all discrepancies and updates output counters, SUCCESS and
finishedAt. Any insert or final transactional update failure rolls back all
results, then FAILED is finalized outside that transaction. The service throws
ReconciliationExecutionError with runId and a sanitized PERSISTENCE_ERROR or
UNEXPECTED_ERROR. No PARTIAL status exists.

Failure to confirm terminal persistence raises ReconciliationFinalizationError
with RUN_FINALIZATION_ERROR/runId. A refresh failure after a committed SUCCESS
never relabels it FAILED. Fixed error messages omit SQL, credentials, database or
Redis details, raw bodies, caught messages and stack traces.

## Executed validation

All database CLI checks used process-local NODE_ENV=test and PORT=3334; tests
selected the guarded separate DB_TEST_DATABASE. No tests wrote development data.

| Check                                                                   | Observed result                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm test` with PORT=3334                                               | 316/316 passed: existing 239 plus 77 M7 tests                                     |
| `npm run lint`                                                          | Passed, including the extended manual E2E script                                  |
| `npm run typecheck`                                                     | Passed                                                                            |
| `npm run format:check`                                                  | Passed after formatting the supplied M7 plan                                      |
| `npm run build`                                                         | Passed                                                                            |
| `node ace migration:run --no-schema-generate`                           | Applied all five migrations to the isolated test DB                               |
| `node ace migration:rollback --step=1 --no-schema-generate`             | Rolled back both M7 tables only                                                   |
| `node ace migration:run --no-schema-generate`                           | Reapplied M7                                                                      |
| `node ace schema:generate`                                              | Six domain tables; generated schema hash identical after the cycle                |
| `node ace migration:reset --no-schema-generate`                         | Reverted five test migrations, preserving generated schema source                 |
| Pre-M7 history migration test                                           | Raw/canonical serialized history unchanged after M7 down/up                       |
| `docker compose config --quiet`                                         | Passed                                                                            |
| `docker compose -f compose.yaml -f compose.dev.yaml config --quiet`     | Passed                                                                            |
| `docker build --target production -t data-integration-platform:local .` | Passed                                                                            |
| `npm run test:async`                                                    | Passed with real Redis, separate API/workers and explicit compiled reconciliation |
| `docker compose ps`                                                     | API/worker running; PostgreSQL, Redis and both provider mocks healthy             |
| API/provider health requests from existing API container                | All three successful                                                              |
| `docker compose exec -T redis redis-cli ping`                           | PONG                                                                              |
| `git diff --check`                                                      | Passed                                                                            |

The 77 added tests cover exact/mixed/missing/status/value/double mismatches,
canonical-only comparison, case/space/leading-zero key distinctions, UNKNOWN,
one-cent differences and large exact/negative amounts, timestamps/counters,
all model relationships and provenance, disabled historical integrations,
repeat explicit pairs ignoring newer runs, invalid IDs, all non-SUCCESS source
statuses, invalid provider roles, same-run selection, incomplete normalization,
duplicate keys, sanitized storage failures, defaults, required fields, all side
shapes, FK/unique/RESTRICT/status/counter constraints, and migration history.

Test-only triggers deterministically reject the second discrepancy only after
an earlier one exists in the same transaction, and separately reject the final
SUCCESS update. Both cases leave zero discrepancies and a FAILED audit. Other
tests exercise start-state failure, audit creation failure, failed finalization,
and post-commit refresh failure. Trigger/functions and temporary method overrides
are restored by cleanup. Existing M0–M6 assertions remain passing.

## Docker and real asynchronous evidence

The built production image runs a disposable test API and separate workers, with
a dedicated timestamped test database and disposable Redis. The existing stack
and shared Redis are retained.

1. HTTP 202 queues a pending integration job with no SyncRun or observations before
   a worker starts.
2. Carrier and TMS both complete through the same unchanged generic job: each
   produces three raw records and three canonical projections. Provider-specific
   raw schemas remain different.
3. Before explicit reconciliation, there are zero ReconciliationRuns. The compiled
   service is then called with those exact two SUCCESS run IDs and returns SUCCESS
   with counters 3/3/3/2. Only SHP-100 and SHP-101 have STATUS_MISMATCH rows, in
   deterministic order; their amounts match and SHP-102 matches completely.
4. Invalid Carrier credentials still produce a failed queue job, sanitized FAILED
   sync audit, zero retries, and no extra canonical observations; HTTP acceptance
   remains 202.
5. Stopping only disposable Redis produces sanitized HTTP 503, no new SyncRun,
   and unchanged development domain counts. The script exits successfully after
   removing its owned containers and timestamped test database.

The new image was validated through disposable containers. Existing application
and shared Redis data were preserved. Final read-only checks found development
integration/run/raw counts of 0/0/0, zero remaining test domain tables or fault
functions, zero disposable validation databases, and no validation containers.

Existing application
containers keep their prior image; no development migration or deployment was
performed. Apply outstanding migrations before starting the updated application
against a development/deployment database.

## Issues and remaining tradeoffs

Initial typecheck caught use of Lucid's insert-only db.table builder for test
updates; using db.from fixed those fixtures. Initial formatting check found only
the newly supplied M7 plan; it was formatted. No failed runtime test remained.
Production npm installation still reports the existing 13 high-severity findings;
dependency/security work was not mixed into M7.

Datasets and the result plan are held in memory. Historical immutability and
provider/key provenance remain application conventions; DB constraints enforce
linkage/shape rather than all cross-table semantic relationships. Integration
provider is read through the current consistent snapshot, not a new frozen
provider field. Direct database mutations can violate historical conventions.
Crash/commit uncertainty, automatic recovery, retries, locks, idempotency,
deduplication and large-dataset streaming remain future work.

M7 is complete. No M8+ functionality, automatic reconciliation, queue wrapper,
HTTP/read endpoint, delivery-date comparison, tolerance, scheduler, or dependency
upgrade was implemented. M8 has not been started.
