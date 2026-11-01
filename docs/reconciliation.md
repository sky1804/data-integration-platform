# Historical shipment reconciliation — M7

Reconciliation compares two explicitly selected historical synchronization runs.
It consumes only NormalizedShipment canonical fields, preserves both datasets,
and stores discrepancies with references back to the exact observations.

```ts
import ReconciliationEngine from '#services/reconciliation_engine'

const run = await new ReconciliationEngine().execute({
  carrierSyncRunId: 10,
  tmsSyncRunId: 20,
})
```

This service returns a refreshed successful ReconciliationRun. It does not select
latest runs, launch synchronization, dispatch jobs, or expose an HTTP endpoint.
SyncEngine and SyncIntegrationJob do not invoke reconciliation automatically.

## Input rules

Both IDs must be distinct positive PostgreSQL integer IDs. Each run must exist,
be SUCCESS, and belong to the expected Integration provider: carrier or tms.
PENDING, RUNNING, PARTIAL, and FAILED source runs are rejected because incomplete
datasets can produce false missing-shipment discrepancies. Current integration
enabled flags do not invalidate otherwise valid historical observations.

Every SourceRecord in each selected run must have its canonical projection. A
pre-M6 historical observation without a projection rejects the whole request;
it is never interpreted as a shipment missing in the other provider. Duplicate
canonical shipment keys within either run also reject the request. Distinct raw
external IDs do not make duplicate canonical keys unambiguous. Empty successful
datasets are valid.

Inputs and preconditions are read in one PostgreSQL REPEATABLE READ snapshot,
without row locks. Only source IDs are selected from SourceRecord; raw payloads
are not loaded or inspected. Validation completes before an audit run is created.

| Precondition                     | Stable error code        |
| -------------------------------- | ------------------------ |
| Invalid ID value                 | INVALID_SYNC_RUN_ID      |
| Missing source run               | SYNC_RUN_NOT_FOUND       |
| Incomplete source execution      | SYNC_RUN_NOT_SUCCESS     |
| Same run or wrong provider roles | INVALID_PROVIDER_PAIR    |
| Missing canonical projections    | INCOMPLETE_NORMALIZATION |
| Duplicate canonical keys         | DUPLICATE_SHIPMENT_KEY   |

Input database or initial audit-creation failures use sanitized PERSISTENCE_ERROR
without claiming that a reconciliation audit exists.

## Comparison rules

Keys use exact JavaScript string equality: case, surrounding spaces, and leading
zeros remain significant. No fuzzy matching or transformation is performed.
Canonical statuses also use exact equality. UNKNOWN is valid: UNKNOWN versus
UNKNOWN matches, while UNKNOWN versus DELIVERED creates a status mismatch.

Amounts are PostgreSQL numeric(15,2) strings produced by M6. Compare those strings
directly, with no Number conversion, rounding, tolerance, epsilon, or threshold.
No raw status, amount/totalValue, delivery date, or provider timestamp is compared.

| Situation                         | Discrepancy        | Carrier reference | TMS reference |
| --------------------------------- | ------------------ | ----------------- | ------------- |
| Present in both, different status | STATUS_MISMATCH    | Required          | Required      |
| Present in both, different amount | VALUE_MISMATCH     | Required          | Required      |
| Only TMS has the key              | MISSING_IN_CARRIER | Null              | Required      |
| Only Carrier has the key          | MISSING_IN_TMS     | Required          | Null          |

A shipment with different status and amount creates two rows. Exact matches
create no discrepancy or separate match row. Keys are processed in deterministic
JavaScript UTF-16 lexical order, with STATUS_MISMATCH before VALUE_MISMATCH for
one key. Missing keys emit only their missing-side type.

## Persistence, lifecycle, and counters

ReconciliationRun belongsTo carrierSyncRun and tmsSyncRun and hasMany discrepancies.
Discrepancy belongsTo reconciliationRun and has nullable carrierNormalizedShipment
and tmsNormalizedShipment relations. Each observation provides provenance through
NormalizedShipment → SourceRecord → SyncRun → Integration. Raw payloads and
canonical values are not duplicated into discrepancy rows.

One migration creates reconciliation_runs and discrepancies; rollback drops them
in dependency order. Foreign keys use ON DELETE RESTRICT. Database CHECKs enforce
the four run statuses, the four discrepancy types, exact nullable-side shapes,
distinct source-run IDs, nonnegative counters, and compared-record bounds.
UNIQUE(reconciliation_run_id, shipment_key, type) prevents duplicate discrepancy
types for a key within a run. There is no unique source-pair constraint.

For a valid request, PENDING is persisted with known input cardinalities, then
RUNNING and startedAt are saved. Comparison creates an in-memory result plan.
One managed transaction inserts all discrepancies and updates counters, SUCCESS,
finishedAt, and cleared error fields. A refreshed successful model is returned.

| Counter            | Meaning                                           |
| ------------------ | ------------------------------------------------- |
| carrierRecords     | Number of selected canonical Carrier observations |
| tmsRecords         | Number of selected canonical TMS observations     |
| comparedRecords    | Number of keys present in both datasets           |
| discrepanciesFound | Number of committed discrepancy rows              |

For Carrier A/B/C and TMS A/B/D, where A matches and B differs in status and
amount, counters are 3/3/2/4. Input counts are retained on failure; comparedRecords
and discrepanciesFound remain zero because the result transaction did not commit.

Any result insert or final transactional update failure rolls back every result.
The service then attempts to persist FAILED, finishedAt, and fixed sanitized
PERSISTENCE_ERROR outside the failed transaction, and throws
ReconciliationExecutionError with runId. Unexpected comparison errors similarly
use UNEXPECTED_ERROR. A failed reconciliation never intentionally retains a
partial discrepancy set, so there is no PARTIAL reconciliation status.

If failure finalization cannot be confirmed, ReconciliationFinalizationError
exposes RUN_FINALIZATION_ERROR and runId. The run may remain RUNNING. A refresh
failure after a committed SUCCESS also raises that finalization error; it does
not relabel committed output as FAILED. Public/audit messages never copy caught
SQL, credentials, raw provider data, connection details, or stack traces.

## Historical behavior and limits

Repeating the same source pair creates another independent reconciliation with
the same results. New synchronization runs do not alter earlier comparisons or
change which source IDs are used. Application paths preserve historical source
and canonical observations, but database-level immutability is not enforced.
Provider roles are checked through the Integration visible in the read snapshot;
there is no new frozen provider metadata field. Direct out-of-band updates can
violate those historical conventions.

Maps and the discrepancy plan are held in memory; large-dataset streaming and
chunked result persistence are not introduced. Cross-table provider/key provenance
is enforced by the service, while database CHECKs protect side-reference shape.
Commit uncertainty, crashes, idempotency, deduplication, locks, retries, recovery,
and automated orchestration remain later work. No new queue job, scheduler,
reconciliation endpoint, read API, current-state table, or delivery-date rule is
added. M8 has not been started.

See [normalization](normalization.md), [SyncEngine](sync-engine.md),
[persistence](sync-lifecycle.md), and [M7 validation](m7-validation.md).
