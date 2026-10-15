# Synchronization engine — M3

`SyncEngine` connects the concrete Carrier client to M1 raw persistence. Execution
is synchronous through its direct API; it neither dispatches jobs nor exposes an
HTTP endpoint. M4's [asynchronous entrypoint](async-sync.md) now wraps it with
`POST /integrations/:id/sync` and a thin Redis-backed job. All execution logic
remains here, and direct execution remains available to application/test code.

```ts
import SyncEngine from '#services/sync_engine'

const run = await new SyncEngine().execute(integration.id)
```

The constructor accepts optional `{ carrierClient, pageSize }`. The client needs
only the existing `CarrierClient.fetchPage` method; tests can substitute that
method without introducing a connector interface. Page size defaults to 100 and
must be an integer from 1 to 100, matching the Carrier boundary. No page-size
environment variable was added.

## Preconditions and lifecycle

Before creating a run, `execute(integrationId)` loads the integration and rejects
missing, disabled, or unsupported providers with `SyncEngineError` codes
`INTEGRATION_NOT_FOUND`, `INTEGRATION_DISABLED`, and `UNSUPPORTED_PROVIDER`.
Only exact provider `carrier` is supported. None of those rejections creates a
run or calls the provider. Database errors while loading/creating the run produce
a sanitized `PERSISTENCE_ERROR`; an unavailable database cannot guarantee an
audit row.

Every valid call creates a fresh `PENDING` run with zero counters, null execution
timestamps, and null failure fields. It explicitly saves `RUNNING` and `startedAt`
before the first provider request. After processing the final page, it saves and
returns a refreshed `SUCCESS` SyncRun with `finishedAt` and no error. Empty
results also succeed.

The service enforces this path for its own executions:

```text
PENDING → RUNNING → SUCCESS
                 → PARTIAL
                 → FAILED
```

PostgreSQL still checks only status membership, not transition order. Direct
model writes are not governed by a state-machine trigger.

## Pagination and persistence

The engine owns the loop, beginning without a cursor and passing the same page
size on every call. CarrierClient remains responsible for HTTP, authorization,
timeouts, parsing and validation. The engine does not revalidate or normalize
returned records.

Each returned record maps to a SourceRecord:

| SourceRecord field | Carrier source                                   |
| ------------------ | ------------------------------------------------ |
| `syncRunId`        | Current run ID                                   |
| `externalId`       | `shipmentId`                                     |
| `payload`          | Complete raw object, including extra fields      |
| `sourceUpdatedAt`  | `DateTime.fromISO(updatedAt, { setZone: true })` |

JSONB retains structure; provider status, amount, names, timestamp string and
additional fields in `payload` remain unchanged. The separate provider timestamp
column represents the same instant using Lucid/Luxon conventions.

After fetching a page, a Lucid managed transaction inserts its SourceRecords and
updates the run's progress counters through that transaction client. Both commit
together. No HTTP request runs inside a database transaction. One failed insert,
including the existing unique constraint for `(sync_run_id, external_id)`, rolls
back the entire page and its progress update. Previous pages remain committed.
Duplicates are neither skipped nor overwritten.

Requested noninitial cursors are tracked in a per-execution Set. Before requesting
a previously used cursor, the engine stops with `PAGINATION_CYCLE`. Records on
the page that returned the repeated next cursor have already been committed and
count normally; the repeated request is never made. Both immediate repeats and
longer cycles terminate. No checkpoint or resume state is stored.

## Counters and terminal failures

| Counter            | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `recordsReceived`  | Validated records actually returned by CarrierClient |
| `recordsPersisted` | SourceRecords in successfully committed pages        |
| `recordsFailed`    | Returned records belonging to a rolled-back page     |

For finalized runs, `received = persisted + failed`. Rejected provider pages and
failed requests contribute no received/failed records. A page persistence failure
counts every record in that page as failed, including inserts rolled back with
the page. For example, two stored records followed by a request failure yield
`2/2/0`; two stored records followed by a failed three-record page yield `5/2/3`.

Any processing error stops execution immediately. The service finalizes counters,
`finishedAt`, a stable code and a sanitized message, then throws
`SyncExecutionError` with `code` and `runId` so callers can load the audit row.
It never returns a failed run as a successful result.

- `SUCCESS`: final page processed with no error, including zero records.
- `PARTIAL`: terminal error and `recordsPersisted > 0`.
- `FAILED`: terminal error and no records persisted, even if empty pages succeeded.

| Failure                                    | Stable code                |
| ------------------------------------------ | -------------------------- |
| CarrierAuthenticationError                 | `PROVIDER_AUTHENTICATION`  |
| CarrierRateLimitError                      | `PROVIDER_RATE_LIMIT`      |
| CarrierUnavailableError                    | `PROVIDER_UNAVAILABLE`     |
| CarrierTimeoutError                        | `PROVIDER_TIMEOUT`         |
| CarrierPayloadValidationError              | `PROVIDER_PAYLOAD_INVALID` |
| CarrierRequestError                        | `PROVIDER_REQUEST_FAILED`  |
| Page transaction/start-state write failure | `PERSISTENCE_ERROR`        |
| Repeated cursor                            | `PAGINATION_CYCLE`         |
| Other processing error                     | `UNEXPECTED_ERROR`         |

Messages are fixed descriptions, never copied from caught exceptions. They omit
tokens, credentials, URLs, response bodies and SQL exception text. If the final
database write/read fails, `SyncFinalizationError` exposes `RUN_FINALIZATION_ERROR`
and `runId` instead of falsely reporting that an outcome was persisted. The run
may remain RUNNING; automatic repair is outside this milestone.

## History, isolation and limitations

Repeated executions create separate runs and observations of the same external
ID. Earlier observations remain unchanged. There is no cross-run deduplication,
lock, retry, resume, single-run constraint or concurrent-run suppression. The same
engine instance keeps all cursor/counter state local to each execution. Concurrent
calls may intentionally create independent historical runs.

M3 functional tests use `testUtils.db().truncate()` only in their group. This
allows real page commits and independent transaction visibility instead of
savepoints under a global test transaction. Existing M1 groups retain
`wrapInGlobalTransaction()`. The functional suite still migrates/resets only the
guarded `_test` database; cleanup truncates test data after each M3 case. Run tests
sequentially against a dedicated database. Never use development data for tests.

A process crash can leave a RUNNING audit row; hard crashes, ambiguous database
commit outcomes and failure to finalize during a database outage require future
recovery policy. No global page bound is imposed on a provider returning an
unending sequence of distinct cursors. Cycle detection covers repeated cursors.
M4 adds asynchronous invocation but does not resolve these recovery limitations.

References: [Lucid transactions](https://lucid.adonisjs.com/docs/transactions),
[Lucid testing utilities](https://lucid.adonisjs.com/docs/testing).
