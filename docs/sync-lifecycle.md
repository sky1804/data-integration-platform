# Synchronization persistence and lifecycle

M1 introduces three persistence entities:

```text
Integration 1 ── N SyncRun 1 ── N SourceRecord
```

- **Integration** identifies a configured provider by name, unique slug, provider
  string, and enabled flag. It stores no credentials or endpoint configuration.
- **SyncRun** records one logical execution, its status, execution timestamps,
  received/persisted/failed counters, and optional failure information.
- **SourceRecord** captures a raw provider observation associated with that run,
  identified by `external_id`, with an optional provider update timestamp.

Lucid models extend the generated `database/schema.ts` classes. Relationships are
`integration.syncRuns`, `syncRun.integration`, `syncRun.sourceRecords`, and
`sourceRecord.syncRun`. `SourceRecord` has no `integration_id`: its integration is
already reachable through its run, avoiding two foreign keys that could disagree.

## Execution lifecycle

```text
PENDING → RUNNING → SUCCESS
                 → PARTIAL
                 → FAILED
```

| Status  | Meaning                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------------- |
| PENDING | Execution exists; processing has not started.                                                             |
| RUNNING | Processing has started.                                                                                   |
| SUCCESS | Synchronization completed and every valid received record was persisted.                                  |
| PARTIAL | Usable data was produced, but some processing failed; for example, 500 received, 498 persisted, 2 failed. |
| FAILED  | No reliable successful result was produced, for example after a provider request and its retries fail.    |

`SUCCESS`, `PARTIAL`, and `FAILED` are terminal. A later manual or scheduled
execution must create a new run, starting at `PENDING`; completed runs are not
reused. M1 documents these transitions but does not enforce them through services,
hooks, or database triggers. The status column is a required string with a check
constraint limiting it to the five supported values; the model narrows its type
to the same values. Callers must supply the status explicitly.

## Historical observations

Source records are conceptually append-only. A shipment observed as `IN_TRANSIT`
in run 10 and `DELIVERED` in run 11 produces two rows. The earlier observation is
retained. There is no `updated_at` on `source_records` and no database-level
append-only protection yet.

`UNIQUE(sync_run_id, external_id)` prevents the same external record from appearing
twice in a run. It permits that identifier in later runs and does not provide full
synchronization idempotency.

Both foreign keys use `ON DELETE RESTRICT`. Integrations with runs and runs with
source records cannot be deleted through cascading operations. Disable an
integration using `enabled`; retention and deliberate historical deletion policies
remain future decisions. Unreferenced rows can still be deleted.

Payloads use PostgreSQL JSONB to retain provider field names, values, nested objects,
arrays, and nulls without domain normalization. JSONB preserves the JSON structure,
not the original HTTP bytes, whitespace, key order, or duplicate object keys.
Neither payload parsing rules nor a provider-specific schema is introduced in M1.

## Constraints and indexes

All IDs are conventional auto-incrementing integer primary keys. Required fields
are non-null. `enabled` defaults to true; run counters default to zero. Nullable
execution/failure/provider timestamps have no synthetic defaults. Timestamps use
PostgreSQL `timestamptz`, exposed as Luxon dates with Lucid timestamp conventions.

The unique slug and composite source-record uniqueness constraints create their
own indexes. `sync_runs.integration_id` has an explicit index for the current
has-many relationship and foreign-key checks. The composite unique index starts
with `sync_run_id`, so a separate source-record run index would be redundant.
There are no speculative payload, provider, status, or external-ID indexes.

## Test isolation

`NODE_ENV=test` selects `DB_TEST_DATABASE` (default `data_integration_test`), using
the same PostgreSQL host, port, and user as development. Configuration rejects a
test database name that lacks the `_test` suffix or equals `DB_DATABASE` before
opening a connection. Test migrations and cleanup cannot silently target the
normal development database through this configuration.

Create the dedicated database once using the README command. Japa uses
`testUtils.db().migrate()` at runner setup; its returned cleanup rolls back test
migrations after the suite. Each persistence test uses
`testUtils.db().wrapInGlobalTransaction()` and its automatic rollback. These are
the [current Lucid test utilities](https://lucid.adonisjs.com/docs/testing).
The test database is disposable and should not contain unrelated data.

The helper disables schema generation during test migration and reset, so test
cleanup cannot erase the committed generated schema file. Generate that file
through `migration:run` or `schema:generate`, never by hand. Formatting excludes
it to preserve the generator's output.

## Deferred work

External API calls, connectors, synchronization orchestration, jobs, scheduling,
endpoints, locks, retries, pagination, normalization, shipments, reconciliation,
manual reprocessing, authentication, frontend, and CI/CD remain out of scope.
Lifecycle enforcement, full idempotency, retention, and append-only protection
also remain deferred. M2 requires explicit instruction.
