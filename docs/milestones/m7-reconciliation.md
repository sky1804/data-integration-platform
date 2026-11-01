# M7 — Shipment Reconciliation and Discrepancies

Status: implemented and validated. See [reconciliation](../reconciliation.md) for
the final design and [M7 validation](../m7-validation.md) for observed evidence.
The requirements below remain the milestone's scope. M8 has not been started.

Implement M7 for `data-integration-platform`.

Before editing:

1. Read `AGENTS.md`.
2. Read this milestone file.
3. Inspect the current repository state.
4. Read only the directly relevant architecture documents:
   - `docs/normalization.md`
   - `docs/sync-engine.md`
   - `docs/sync-lifecycle.md`
   - `docs/roadmap.md`
5. Treat current code, models and migrations as the source of truth.

Do not depend on previous Codex conversation context.

Do not proceed to M8.

---

# Objective

M6 produces canonical historical observations:

```text
Carrier SyncRun
    ↓
SourceRecord
    ↓
NormalizedShipment

TMS SyncRun
    ↓
SourceRecord
    ↓
NormalizedShipment
```

M7 compares one explicit successful Carrier run against one explicit successful TMS run and records business discrepancies.

Target:

```text
Carrier SyncRun ─────┐
                     │
                     ▼
              ReconciliationEngine
                     ▲
                     │
TMS SyncRun ─────────┘
                     │
                     ▼
             ReconciliationRun
                     │
                     ▼
                Discrepancy
```

---

# 1. Explicit input runs

The reconciliation API at service level should be conceptually:

```ts
await reconciliationEngine.execute({
  carrierSyncRunId,
  tmsSyncRunId,
})
```

Do NOT automatically query:

```text
latest Carrier run
latest TMS run
```

M7 must compare explicit immutable historical datasets.

This makes reconciliation:

```text
repeatable
auditable
deterministic
```

given the same selected runs.

---

# 2. Only SUCCESS runs

Only allow:

```text
SyncRun.status = SUCCESS
```

for reconciliation.

Reject:

```text
PENDING
RUNNING
PARTIAL
FAILED
```

Reason:

A PARTIAL provider dataset could cause false:

```text
MISSING_IN_CARRIER
MISSING_IN_TMS
```

because the source synchronization itself was incomplete.

Do not reconcile incomplete runs in M7.

---

# 3. Provider roles

Validate:

```text
carrierSyncRunId
→ belongs to Integration.provider = carrier

tmsSyncRunId
→ belongs to Integration.provider = tms
```

Do not allow:

```text
Carrier vs Carrier
TMS vs TMS
reversed provider roles
unsupported provider
same SyncRun on both sides
```

Use explicit carrier/tms roles rather than generic left/right terminology.

This milestone reconciles the two concrete business sources that currently exist.

---

# 4. Complete normalization precondition

Before reconciliation, verify each selected SyncRun has complete canonical projections.

For each run:

```text
number of SourceRecords
==
number of linked NormalizedShipments
```

A historical pre-M6 run may legitimately contain SourceRecords with no normalized projection.

Such a run must be rejected for M7.

Use a stable error such as:

```text
INCOMPLETE_NORMALIZATION
```

Do not interpret missing projections as missing shipments in the other provider.

---

# 5. Canonical matching key

Match using:

```text
NormalizedShipment.shipmentKey
```

Current equality rule is exact string equality.

Therefore:

```text
SHP-100
```

does NOT automatically equal:

```text
shp-100
```

and:

```text
00123
```

does NOT automatically equal:

```text
123
```

M6 intentionally did not trim, lowercase, strip zeros, or otherwise rewrite keys.

M7 must not invent fuzzy matching rules.

If future requirements establish canonical key transformations, implement them deliberately in a later milestone.

---

# 6. Duplicate key protection

Within one selected SyncRun, reconciliation expects at most one canonical observation for each `shipmentKey`.

Before comparing, detect duplicate canonical keys inside either selected run.

If detected, fail predictably with something equivalent to:

```text
DUPLICATE_SHIPMENT_KEY
```

Do not arbitrarily choose the first or last row.

Do not create misleading discrepancies from ambiguous input.

This is a service-level validation because the canonical key may diverge from source external IDs in future normalizers.

---

# 7. Discrepancy types

M7 supports exactly:

```text
STATUS_MISMATCH
VALUE_MISMATCH
MISSING_IN_CARRIER
MISSING_IN_TMS
```

Do NOT implement:

```text
DELIVERY_DATE_MISMATCH
```

M6 deliberately did not canonicalize delivery date because Carrier and TMS do not currently expose semantically equivalent delivery-date fields.

Do not compare raw provider date fields.

---

# 8. Reconciliation rules

For each shipment key in the union of both datasets:

## Missing in Carrier

TMS contains:

```text
SHP-100
```

Carrier does not.

Create:

```text
MISSING_IN_CARRIER
```

---

## Missing in TMS

Carrier contains:

```text
SHP-100
```

TMS does not.

Create:

```text
MISSING_IN_TMS
```

---

## Present in both — status

Carrier canonical:

```text
DELIVERED
```

TMS canonical:

```text
IN_TRANSIT
```

Create:

```text
STATUS_MISMATCH
```

---

## Present in both — amount

Carrier canonical:

```text
1250.50
```

TMS canonical:

```text
1300.00
```

Create:

```text
VALUE_MISMATCH
```

Amounts are already canonical exact `numeric(15,2)` values exposed as strings.

Use exact canonical equality.

Do NOT introduce:

```text
tolerance
epsilon
percentage threshold
rounding during reconciliation
```

M6 has already defined the precision.

---

# 9. Multiple discrepancies per shipment

A shipment may have more than one discrepancy.

Example:

```text
Carrier
SHP-100
DELIVERED
1250.50

TMS
SHP-100
IN_TRANSIT
1300.00
```

Create both:

```text
STATUS_MISMATCH
VALUE_MISMATCH
```

Do not collapse those into a generic:

```text
MISMATCH
```

---

# 10. Matching records

If:

```text
shipmentKey equal
status equal
amount equal
```

create no Discrepancy row.

Do not create a separate MATCH table.

Successful matches are represented by the absence of discrepancies plus reconciliation counters.

---

# 11. ReconciliationRun

Create a new historical entity:

```text
ReconciliationRun
```

Suggested table:

```text
reconciliation_runs
```

Suggested fields:

```text
id

carrier_sync_run_id
tms_sync_run_id

status

carrier_records
tms_records
compared_records
discrepancies_found

started_at
finished_at

error_code
error_message

created_at
updated_at
```

Use appropriate integer defaults for counters.

---

# 12. ReconciliationRun relationships

Add:

```text
ReconciliationRun
  belongsTo carrierSyncRun
  belongsTo tmsSyncRun
  hasMany discrepancies
```

Both source-run foreign keys should use:

```text
ON DELETE RESTRICT
```

The historical synchronization datasets used by a reconciliation must not be deletable while referenced.

---

# 13. Reconciliation status

Use:

```text
PENDING
RUNNING
SUCCESS
FAILED
```

Add a PostgreSQL CHECK constraint.

Do not add:

```text
PARTIAL
```

M7 reconciliation output should be atomic.

Either:

```text
all discrepancies are committed
```

or:

```text
none are committed
```

---

# 14. Lifecycle

For a valid pair:

```text
PENDING
   ↓
RUNNING
   ↓
SUCCESS
```

or:

```text
PENDING
   ↓
RUNNING
   ↓
FAILED
```

Set timestamps consistently.

Do not reuse a completed ReconciliationRun.

Calling reconciliation again for the same SyncRun pair may create another ReconciliationRun.

Idempotency/deduplication belongs to M8.

Do not add a UNIQUE constraint on:

```text
(carrier_sync_run_id, tms_sync_run_id)
```

during M7.

---

# 15. Counter semantics

Define:

```text
carrier_records
```

= number of canonical Carrier observations selected.

```text
tms_records
```

= number of canonical TMS observations selected.

```text
compared_records
```

= number of shipment keys present in both datasets.

```text
discrepancies_found
```

= number of Discrepancy rows created.

Example:

```text
Carrier:
A
B
C

TMS:
A
B
D
```

Then:

```text
carrier_records = 3
tms_records = 3
compared_records = 2
```

If:

```text
A = exact match

B =
status mismatch
value mismatch

C missing in TMS

D missing in Carrier
```

then:

```text
discrepancies_found = 4
```

because B generates two discrepancy rows.

---

# 16. Discrepancy entity

Create:

```text
Discrepancy
```

Suggested table:

```text
discrepancies
```

Fields:

```text
id

reconciliation_run_id
shipment_key
type

carrier_normalized_shipment_id nullable
tms_normalized_shipment_id nullable

created_at
```

Do not duplicate entire raw payloads or canonical values into this table.

The referenced normalized rows already contain the canonical values and have provenance back to:

```text
NormalizedShipment
→ SourceRecord
→ SyncRun
→ Integration
```

---

# 17. Discrepancy foreign keys

Use:

```text
reconciliation_run_id
→ reconciliation_runs.id

carrier_normalized_shipment_id
→ normalized_shipments.id

tms_normalized_shipment_id
→ normalized_shipments.id
```

Use:

```text
ON DELETE RESTRICT
```

for historical audit integrity.

---

# 18. Discrepancy type constraint

Add database CHECK for exactly:

```text
STATUS_MISMATCH
VALUE_MISMATCH
MISSING_IN_CARRIER
MISSING_IN_TMS
```

Also narrow the model type in TypeScript.

---

# 19. Side-reference invariants

Protect the relationship shape in PostgreSQL where practical.

Expected:

```text
STATUS_MISMATCH
VALUE_MISMATCH
```

must reference:

```text
Carrier normalized row
AND
TMS normalized row
```

Expected:

```text
MISSING_IN_CARRIER
```

must contain:

```text
carrier_normalized_shipment_id = null
tms_normalized_shipment_id != null
```

Expected:

```text
MISSING_IN_TMS
```

must contain:

```text
carrier_normalized_shipment_id != null
tms_normalized_shipment_id = null
```

Prefer a table CHECK constraint enforcing these combinations.

Do not rely only on application code.

---

# 20. Duplicate discrepancy protection

Add:

```text
UNIQUE(
  reconciliation_run_id,
  shipment_key,
  type
)
```

The same reconciliation must not contain two identical discrepancy types for the same key.

A key may still contain:

```text
STATUS_MISMATCH
+
VALUE_MISMATCH
```

because the type differs.

---

# 21. Indexes

Add only useful known indexes.

The unique discrepancy constraint already supports lookups beginning with:

```text
reconciliation_run_id
```

A separate `shipment_key` index is reasonable for future investigation/query API use.

Avoid speculative indexing.

---

# 22. ReconciliationEngine

Create a focused service such as:

```text
app/services/reconciliation_engine.ts
```

and errors such as:

```text
app/services/reconciliation_engine_errors.ts
```

Public API concept:

```ts
const run = await reconciliationEngine.execute({
  carrierSyncRunId,
  tmsSyncRunId,
})
```

Return the successful refreshed `ReconciliationRun`.

---

# 23. Precondition failures

Validate before creating a ReconciliationRun where practical:

```text
source SyncRun exists
source SyncRun SUCCESS
correct provider role
normalization complete
no duplicate shipment keys
```

Use predictable errors such as:

```text
SYNC_RUN_NOT_FOUND
SYNC_RUN_NOT_SUCCESS
INVALID_PROVIDER_PAIR
INCOMPLETE_NORMALIZATION
DUPLICATE_SHIPMENT_KEY
```

These are input/precondition failures, not reconciliation outcomes.

Do not create an audit run for a request that was invalid before reconciliation actually began.

---

# 24. Reconciliation algorithm

Prefer a simple deterministic implementation.

Conceptually:

```ts
const carrierByKey = new Map(...)
const tmsByKey = new Map(...)

const keys = union(
  carrierByKey.keys(),
  tmsByKey.keys()
)

for (const key of keys) {
  const carrier = carrierByKey.get(key)
  const tms = tmsByKey.get(key)

  if (!carrier) {
    MISSING_IN_CARRIER
    continue
  }

  if (!tms) {
    MISSING_IN_TMS
    continue
  }

  if (carrier.status !== tms.status) {
    STATUS_MISMATCH
  }

  if (carrier.amount !== tms.amount) {
    VALUE_MISMATCH
  }
}
```

Do not inspect raw payloads for reconciliation rules.

Use only canonical fields produced by M6.

---

# 25. Deterministic ordering

When persisting discrepancies, use deterministic ordering.

Prefer ordering by:

```text
shipment_key
```

and then a stable discrepancy-type order.

This improves tests and audit readability.

Do not depend on JavaScript/database incidental ordering.

---

# 26. Atomic reconciliation output

Persist reconciliation results atomically.

Preferred behavior:

```text
ReconciliationRun RUNNING

BEGIN

insert every Discrepancy
update reconciliation counters
mark ReconciliationRun SUCCESS
set finished_at

COMMIT
```

If any discrepancy insert or final transactional update fails:

```text
ROLLBACK all discrepancy rows from this execution
```

Then attempt to finalize:

```text
ReconciliationRun FAILED
```

outside the failed result transaction.

A FAILED reconciliation must not leave a partial discrepancy set.

---

# 27. Failure semantics

Use sanitized stable failure codes.

At minimum:

```text
PERSISTENCE_ERROR
UNEXPECTED_ERROR
```

Precondition codes remain separate as described earlier.

If final FAILED-state persistence itself cannot be guaranteed, use a specific finalization error similar to the existing SyncEngine pattern.

Do not expose:

```text
SQL
connection strings
credentials
raw provider payloads
stack traces
```

in audit messages.

Preserve internal causes for future logging only if this can be done without leaking them to persisted/public messages.

---

# 28. No PARTIAL reconciliation

This distinction is important.

Synchronization may be:

```text
PARTIAL
```

because previous provider pages may already be valid and committed.

Reconciliation should not be partial.

Its inputs are already fixed historical datasets.

Therefore result creation is one atomic logical operation:

```text
SUCCESS
or
FAILED
```

---

# 29. No raw-data reconciliation

Do NOT compare:

```text
Carrier payload.status
against
TMS payload.status
```

Do NOT compare:

```text
amount
against
totalValue
```

directly.

That problem was solved in M6.

M7 consumes:

```text
shipmentKey
status
amount
```

from NormalizedShipment only.

---

# 30. No delivery-date comparison

Do not inspect:

```text
TMS deliveryDate
Carrier updatedAt
TMS lastModifiedAt
```

for business discrepancies.

Those fields do not represent an established shared canonical concept.

`DELIVERY_DATE_MISMATCH` remains deferred.

---

# 31. UNKNOWN status behavior

`UNKNOWN` is a valid canonical value.

Examples:

```text
Carrier UNKNOWN
TMS UNKNOWN
```

→ no status discrepancy.

```text
Carrier UNKNOWN
TMS DELIVERED
```

→ STATUS_MISMATCH.

Do not make UNKNOWN itself an error.

Do not inspect the raw unknown strings during reconciliation.

---

# 32. Exact amount behavior

Amounts are canonical `numeric(15,2)` string values.

Examples:

```text
"1250.50" == "1250.50"
```

match.

```text
"1250.50" != "1250.51"
```

VALUE_MISMATCH.

Do not convert back to JavaScript floating point.

Do not introduce tolerance.

---

# 33. Historical behavior

A ReconciliationRun must remain tied to the exact two SyncRun IDs selected.

Example:

```text
Carrier Run #10
TMS Run #20
→ Reconciliation #100
```

Later synchronization:

```text
Carrier Run #11
TMS Run #21
```

does not change Reconciliation #100.

A new comparison creates:

```text
Reconciliation #101
```

This is historical reconciliation, not a mutable current-state comparison.

---

# 34. No automatic reconciliation trigger

Do NOT automatically reconcile whenever both providers finish.

Do not modify:

```text
SyncIntegrationJob
SyncEngine
```

to launch reconciliation.

Do not add scheduler behavior.

M7's `ReconciliationEngine` is invoked explicitly in service/test code.

Automatic orchestration can be designed later.

---

# 35. No reconciliation Queue job yet

Do not add:

```text
ReconciliationJob
queue.dispatch(...)
POST /reconciliations
```

during M7.

The reconciliation domain should first be independently correct, similar to how SyncEngine was implemented before asynchronous wrapping.

Existing synchronization Queue behavior must remain unchanged.

---

# 36. No read API yet

Do not add:

```text
GET /reconciliations
GET /reconciliations/:id
GET /discrepancies
```

M9 owns the read/query REST API.

M7 only implements domain persistence and execution.

---

# 37. Model relationships

Add useful Lucid relationships.

Expected conceptually:

```text
ReconciliationRun
├─ carrierSyncRun
├─ tmsSyncRun
└─ discrepancies

Discrepancy
├─ reconciliationRun
├─ carrierNormalizedShipment nullable
└─ tmsNormalizedShipment nullable
```

Use current AdonisJS/Lucid conventions.

Regenerate `database/schema.ts`.

Do not edit the generated schema manually.

---

# 38. Tests — exact match

Create successful Carrier and TMS SyncRuns with equivalent canonical rows.

Example:

```text
Carrier
SHP-100 / DELIVERED / 1250.50

TMS
SHP-100 / DELIVERED / 1250.50
```

Expected:

```text
ReconciliationRun SUCCESS

carrier_records = 1
tms_records = 1
compared_records = 1
discrepancies_found = 0

0 Discrepancies
```

---

# 39. Tests — status mismatch

```text
Carrier
SHP-100 / DELIVERED / 1250.50

TMS
SHP-100 / IN_TRANSIT / 1250.50
```

Expected:

```text
STATUS_MISMATCH
```

with both normalized shipment references.

---

# 40. Tests — value mismatch

```text
Carrier
SHP-100 / DELIVERED / 1250.50

TMS
SHP-100 / DELIVERED / 1300.00
```

Expected:

```text
VALUE_MISMATCH
```

with both normalized references.

---

# 41. Tests — two mismatches on one shipment

```text
Carrier
SHP-100 / DELIVERED / 1250.50

TMS
SHP-100 / IN_TRANSIT / 1300.00
```

Expected exactly:

```text
STATUS_MISMATCH
VALUE_MISMATCH
```

No generic duplicate discrepancy.

---

# 42. Tests — missing Carrier

Only TMS contains:

```text
SHP-100
```

Expected:

```text
MISSING_IN_CARRIER

carrierNormalizedShipment = null
tmsNormalizedShipment != null
```

---

# 43. Tests — missing TMS

Only Carrier contains:

```text
SHP-100
```

Expected:

```text
MISSING_IN_TMS

carrierNormalizedShipment != null
tmsNormalizedShipment = null
```

---

# 44. Tests — mixed reconciliation

Test a realistic combined dataset.

Example:

```text
Carrier:
A exact
B wrong status
C wrong value
D missing in TMS
E wrong status + wrong value

TMS:
A exact
B
C
E
F missing in Carrier
```

Expected discrepancy rows:

```text
B STATUS_MISMATCH

C VALUE_MISMATCH

D MISSING_IN_TMS

E STATUS_MISMATCH
E VALUE_MISMATCH

F MISSING_IN_CARRIER
```

Counters must match the defined semantics.

---

# 45. Tests — exact key semantics

Prove:

```text
SHP-100
```

and:

```text
shp-100
```

are treated as different keys.

Expected:

```text
MISSING_IN_TMS for SHP-100
MISSING_IN_CARRIER for shp-100
```

Do not silently case-normalize.

---

# 46. Tests — UNKNOWN

Test:

```text
UNKNOWN vs UNKNOWN
```

→ no status mismatch.

Test:

```text
UNKNOWN vs DELIVERED
```

→ STATUS_MISMATCH.

---

# 47. Tests — invalid SyncRun states

Reject Carrier/TMS runs in:

```text
PENDING
RUNNING
PARTIAL
FAILED
```

No ReconciliationRun should be created.

This specifically protects against false missing discrepancies.

---

# 48. Tests — provider roles

Reject:

```text
Carrier run passed as TMS
TMS run passed as Carrier
Carrier vs Carrier
TMS vs TMS
same run ID
```

No ReconciliationRun.

---

# 49. Tests — incomplete normalization

Create a successful historical SyncRun containing:

```text
SourceRecord
without NormalizedShipment
```

Expected:

```text
INCOMPLETE_NORMALIZATION
```

No ReconciliationRun and no discrepancies.

---

# 50. Tests — duplicate canonical key

Create two normalized rows belonging to the same selected SyncRun with:

```text
shipmentKey = SAME
```

but different source records.

Expected:

```text
DUPLICATE_SHIPMENT_KEY
```

Do not select one arbitrarily.

No reconciliation output should be created.

---

# 51. Tests — database constraints

At minimum test database rejection for:

```text
invalid ReconciliationRun status

missing source-run foreign keys

invalid discrepancy type

missing reconciliation_run_id

duplicate:
reconciliation_run_id + shipment_key + type

invalid side-reference combination

dangling normalized-shipment foreign keys

deleting referenced SyncRuns

deleting referenced NormalizedShipments
```

---

# 52. Tests — atomic discrepancy persistence

Deterministically force a discrepancy insert failure after at least one discrepancy would have been inserted.

Verify:

```text
0 discrepancies remain from that reconciliation transaction
```

and:

```text
ReconciliationRun = FAILED
```

Do not leave a partial discrepancy set.

Use an isolated database test mechanism similar in quality to the M6 atomicity test.

Clean up any test-only trigger/function.

---

# 53. Tests — repeat reconciliation

Running:

```ts
execute({
  carrierSyncRunId: 10,
  tmsSyncRunId: 20,
})
```

twice should currently produce:

```text
two ReconciliationRuns
```

with independently persisted identical results.

Do not deduplicate in M7.

M8 may introduce idempotency policy.

---

# 54. Existing synchronization regression

All existing M0–M6 behavior must remain valid.

Do not modify normalization semantics merely to simplify reconciliation.

In particular:

```text
raw SourceRecord history
NormalizedShipment history
Queue synchronization
Carrier
TMS
```

must remain unchanged.

---

# 55. Documentation

Create:

```text
docs/reconciliation.md
```

Document concisely:

- explicit SyncRun pair selection;
- SUCCESS-only rule;
- normalization completeness;
- exact shipment-key equality;
- discrepancy types;
- exact status/amount comparisons;
- missing semantics;
- multiple discrepancies per shipment;
- ReconciliationRun lifecycle;
- atomic output;
- why there is no PARTIAL reconciliation;
- historical/reproducible behavior;
- deferred automatic triggering/API/idempotency.

Create:

```text
docs/m7-validation.md
```

with observed validation evidence.

Update:

```text
docs/roadmap.md
```

only after M7 passes validation:

```text
M7 ✅
M8 NEXT
```

Update other architecture docs only where current wording becomes stale.

Do not rewrite historical validation files.

---

# 56. Migration validation

Validate the new migrations through the repository's established isolated test database process.

At minimum:

```text
apply
rollback M7
reapply
schema generate
```

Verify pre-M7 M6 history survives the new migration unchanged.

---

# 57. Validation

Run and record:

```text
npm test
npm run lint
npm run typecheck
npm run format:check
npm run build
```

Also validate:

```text
production Docker build
default Compose config
development Compose config
existing async synchronization E2E
```

M7 should not require new Docker services.

Existing services remain:

```text
api
worker
postgres
redis
carrier-mock
tms-mock
```

---

# 58. Expected architecture after M7

```text
Carrier API                 TMS API
    ↓                          ↓
CarrierClient              TmsClient
    ↓                          ↓
CarrierConnector           TmsConnector
          \                 /
           \               /
              SyncEngine
                  ↓
             SourceRecord
                  ↓
         NormalizedShipment
                  │
                  │ selected historical
                  │ SUCCESS SyncRuns
                  ▼
        ReconciliationEngine
                  ↓
         ReconciliationRun
                  ↓
             Discrepancy
```

---

# 59. Explicit exclusions

Do NOT implement:

```text
automatic reconciliation after synchronization

Reconciliation queue jobs

reconciliation HTTP endpoints

read/query endpoints

current-state shipment table

fuzzy shipment-key matching

case-insensitive matching

delivery-date comparison

amount tolerance

automatic retry
backoff
locks
idempotency
deduplication

scheduler

authentication
frontend
CI/CD
```

These belong to later milestones.

---

# 60. Suggested implementation structure

Keep it small.

Likely additions:

```text
app/models/reconciliation_run.ts
app/models/discrepancy.ts

app/services/reconciliation_engine.ts
app/services/reconciliation_engine_errors.ts

database/migrations/...create_reconciliation_runs...
database/migrations/...create_discrepancies...

tests/functional/reconciliation.spec.ts

docs/reconciliation.md
docs/m7-validation.md
```

Do not add extra architectural layers without a concrete need.

---

# 61. Suggested commit

Prefer one cohesive commit if practical:

```text
feat: add shipment reconciliation
```

A migration/domain split is acceptable only if both commits remain independently coherent.

Do not mix dependency upgrades or M8 work.

---

# 62. Completion report

When finished, report:

1. files created;
2. files modified;
3. database migrations;
4. ReconciliationRun schema/model;
5. Discrepancy schema/model;
6. service public API;
7. precondition rules;
8. exact matching semantics;
9. discrepancy rules;
10. counter semantics;
11. lifecycle;
12. transaction/atomicity strategy;
13. failure codes;
14. database constraints;
15. tests added;
16. total test results;
17. migration validation;
18. Docker/build regression;
19. async synchronization regression;
20. issues encountered;
21. unresolved tradeoffs;
22. confirmation that no M8+ functionality was implemented.

Do not start M8.
