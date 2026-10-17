# M6 — Canonical Shipment Normalization

Status: planned; implementation has not started. This document defines the scope
for a future explicit M6 implementation request. Reading, reviewing, or committing
it does not authorize starting M6.

Implement M6 for the `data-integration-platform`.

Before editing:

1. Read the applicable `AGENTS.md`.
2. Read this milestone file.
3. Inspect the current repository state.
4. Read only the architecture documents directly relevant to this change, especially:
   - `docs/connectors.md`
   - `docs/sync-engine.md`
   - `docs/m5-validation.md`
5. Treat current code and migrations as the source of truth.

Do not depend on knowledge from a previous Codex conversation.

Do not proceed beyond M6.

---

# 1. Current architecture

M5 currently provides:

```text
HTTP
 ↓
Redis Queue
 ↓
SyncIntegrationJob
 ↓
SyncEngine
 ↓
Connector
 ├─ CarrierConnector → CarrierClient → Carrier API
 └─ TmsConnector     → TmsClient     → TMS API
```

Persistence currently stores:

```text
Integration
   ↓
SyncRun
   ↓
SourceRecord
```

`SourceRecord` is an append-only-style historical raw observation.

Carrier and TMS observations for the same conceptual shipment deliberately retain different payload schemas.

M6 introduces a canonical business projection while preserving raw records unchanged.

---

# 2. M6 objective

After M6:

```text
Provider API
    ↓
Client
    ↓
Connector
    ↓
SourceObservation
    ↓
SyncEngine
    ↓
page transaction
    │
    ├── SourceRecord
    │      raw provider payload
    │
    └── NormalizedShipment
           canonical business projection
```

Every successfully persisted SourceRecord produced by the normal M6 synchronization path should have exactly one canonical NormalizedShipment projection.

This applies to observations ingested after M6 is deployed. Existing historical
SourceRecords remain unchanged and may have no normalized projection. M6 does not
backfill earlier runs; the migration creates the new table without rewriting raw
history. Test migration against a database containing pre-M6 observations.

Raw data and normalized data have different responsibilities.

---

# 3. Critical invariant

Never replace raw provider data with normalized data.

Carrier raw payload must still look like:

```json
{
  "shipmentId": "SHP-100",
  "status": "DELIVERED",
  "amount": 1250.5,
  "updatedAt": "2026-10-04T12:00:00Z"
}
```

TMS raw payload must still look like:

```json
{
  "shipmentCode": "SHP-100",
  "status": "FINALIZADO",
  "totalValue": 1250.5,
  "deliveryDate": "2026-10-04",
  "lastModifiedAt": "2026-10-04T13:00:00Z"
}
```

Normalization creates another record.

It does not mutate `SourceRecord.payload`.

---

# 4. Canonical shipment model

Introduce a canonical historical projection.

Preferred name:

```text
NormalizedShipment
```

Suggested table:

```text
normalized_shipments
```

This is NOT a "current shipment state" table.

Each row represents the normalized projection of one SourceRecord observation.

Relationship:

```text
SourceRecord
    1
    │
    │
    1
NormalizedShipment
```

Add:

```text
SourceRecord hasOne NormalizedShipment
NormalizedShipment belongsTo SourceRecord
```

---

# 5. Suggested schema

Create a migration for:

```text
normalized_shipments
```

Fields:

```text
id

source_record_id
shipment_key
status
amount

created_at
```

## source_record_id

Required foreign key:

```text
normalized_shipments.source_record_id
→ source_records.id
```

Use:

```text
ON DELETE RESTRICT
```

Add:

```text
UNIQUE(source_record_id)
```

One raw observation may have at most one canonical shipment projection.

The foreign key and unique constraint enforce linkage and at most one projection.
They do not require every SourceRecord to have a projection. The normal M6
synchronization path enforces raw/projection creation together through its page
transaction; do not add a mandatory-child constraint that rejects pre-M6 history.

---

# 6. shipment_key

`shipment_key` is the canonical business matching key.

For current providers:

```text
Carrier shipmentId
→ shipment_key

TMS shipmentCode
→ shipment_key
```

Today this will usually equal `SourceRecord.externalId`.

Still store it explicitly because:

```text
SourceRecord.externalId
= source-system identifier

NormalizedShipment.shipmentKey
= canonical reconciliation key
```

Future providers may require formatting or composite-key rules.

M6 must not implement such future rules yet.

---

# 7. Canonical status

Use a small explicit canonical status set:

```text
PENDING
IN_TRANSIT
DELIVERED
CANCELED
UNKNOWN
```

Represent this in TypeScript.

Also add a PostgreSQL CHECK constraint.

The database must reject any other canonical status.

Do not rely only on a TypeScript union.

---

# 8. Carrier status mapping

Carrier mapping:

```text
PENDING
→ PENDING

IN_TRANSIT
→ IN_TRANSIT

DELIVERED
→ DELIVERED

CANCELED
→ CANCELED
```

Any other syntactically valid Carrier status:

```text
→ UNKNOWN
```

Do not fail synchronization merely because Carrier introduces a previously unknown status string.

The exact original status remains available in `SourceRecord.payload`.

---

# 9. TMS status mapping

TMS mapping:

```text
CRIADO
→ PENDING

EM_TRANSITO
→ IN_TRANSIT

FINALIZADO
→ DELIVERED

CANCELADO
→ CANCELED
```

Any other syntactically valid TMS status:

```text
→ UNKNOWN
```

Do not silently treat unknown status as one of the known statuses.

Do not fail normal ingestion solely because a new provider status appears.

---

# 10. UNKNOWN is intentional

`UNKNOWN` is important.

Example:

```text
TMS changes:

EM_SEPARACAO
```

M6 should produce:

```text
canonical status = UNKNOWN
```

while preserving:

```json
{
  "status": "EM_SEPARACAO"
}
```

in the raw payload.

This provides forward compatibility without hiding the original provider value.

Later observability may surface unknown mappings.

Do not implement alerting in M6.

---

# 11. Canonical amount

Map:

```text
Carrier.amount
→ NormalizedShipment.amount

TMS.totalValue
→ NormalizedShipment.amount
```

This represents a monetary/business value.

Do not use floating-point database storage.

Prefer a PostgreSQL exact numeric/decimal column with an explicit precision/scale appropriate for shipment values.

Inspect current Lucid/PostgreSQL behavior and model typing before choosing the exact model representation.

Do not silently round values beyond the chosen scale.

If exact scale validation is necessary, implement and test it explicitly.

Do not add a money library merely for this milestone unless genuinely required.

Document the chosen database and TypeScript representation.

---

# 12. No currency yet

Neither current provider contract supplies a currency.

Therefore do NOT invent:

```text
currency = BRL
```

and do not add a currency column with guessed data.

Currency support can be introduced when backed by provider/domain requirements.

---

# 13. Delivery date is deferred

TMS currently supplies:

```text
deliveryDate
```

Carrier does not supply a semantically equivalent delivery date.

Do NOT map:

```text
Carrier.updatedAt
```

to delivery date.

Those fields mean different things.

Therefore M6 canonical fields are currently:

```text
shipmentKey
status
amount
```

Delivery-date normalization is deferred until comparable source semantics exist.

Document this decision.

---

# 14. Normalization boundary

Create a small business-normalization boundary.

Suggested structure:

```text
app/normalization/
├── shipment_normalizer.ts
├── carrier_shipment_normalizer.ts
├── tms_shipment_normalizer.ts
└── shipment_normalizer_factory.ts
```

Naming may vary if current project conventions suggest something cleaner.

Keep it small.

---

# 15. Normalizer interface

Suggested concept:

```ts
export interface NormalizedShipmentData {
  shipmentKey: string
  status: CanonicalShipmentStatus
  amount: ...
}

export interface ShipmentNormalizer {
  normalize(
    observation: SourceObservation
  ): NormalizedShipmentData
}
```

A pure function-based design is also acceptable if simpler.

Do not introduce a dependency-injection framework.

---

# 16. Separation from Connector

Connector responsibility remains:

```text
provider HTTP
      ↓
validated raw record
      ↓
ingestion metadata
```

Normalizer responsibility becomes:

```text
validated provider observation
      ↓
canonical business fields
```

Correct:

```text
CarrierConnector
→ externalId
→ sourceUpdatedAt
→ raw payload

CarrierShipmentNormalizer
→ shipmentKey
→ canonical status
→ canonical amount
```

Do not move normalization into Connector.

That separation is important.

---

# 17. Carrier normalizer

Carrier normalizer consumes Carrier's raw provider shape from the SourceObservation.

It maps:

```text
shipmentId
→ shipmentKey

status
→ canonical status

amount
→ canonical amount
```

It must not:

```text
mutate payload
persist records
perform HTTP
reconcile
```

---

# 18. TMS normalizer

TMS normalizer maps:

```text
shipmentCode
→ shipmentKey

status
→ canonical status

totalValue
→ canonical amount
```

It must not convert unrelated TMS-specific fields into Carrier-shaped fields.

For example:

```text
deliveryDate
```

remains only in raw data for now.

---

# 19. Normalizer resolver

Add the smallest resolver needed.

Conceptually:

```ts
createShipmentNormalizer(provider)
```

with:

```text
carrier
→ CarrierShipmentNormalizer

tms
→ TmsShipmentNormalizer
```

Do not build a dynamic plugin framework.

The supported provider set should remain consistent with the existing Connector provider set.

Avoid maintaining two contradictory provider lists if a small shared type/helper can prevent drift.

---

# 20. SyncEngine integration

M6 should integrate canonical persistence into the existing page transaction.

For each SourceObservation:

```text
normalize observation
      ↓
create SourceRecord
      ↓
create NormalizedShipment linked to SourceRecord
```

Both must participate in the same existing page transaction.

Conceptually:

```text
BEGIN

SourceRecord #1
NormalizedShipment #1

SourceRecord #2
NormalizedShipment #2

SourceRecord #3
NormalizedShipment #3

SyncRun progress update

COMMIT
```

This gives the invariant:

```text
committed M6 observation
→ raw + canonical projection exist together
```

---

# 21. Page atomicity

If canonical persistence fails for one record:

```text
ROLLBACK the entire page
```

including:

```text
SourceRecords created in that page
NormalizedShipments created in that page
progress-counter update
```

Previously committed pages remain intact.

Preserve M3 page-level transaction semantics.

Do not create nested transactions unnecessarily.

---

# 22. Normalization failure semantics

Expected provider statuses outside the known mapping must NOT be considered normalization failures.

They map to:

```text
UNKNOWN
```

However, an actual unexpected normalization failure should terminate processing.

Introduce a stable failure code only if a meaningful normalization-specific runtime failure can occur in the implementation:

```text
NORMALIZATION_ERROR
```

Do not create this code merely for unknown statuses.

If normalizer code cannot produce a recoverable runtime failure after Connector validation, keep unexpected implementation failures under the existing safe failure handling.

Prefer the simplest truthful model.

---

# 23. Existing counters

Do not add normalization counters in M6.

Keep:

```text
recordsReceived
recordsPersisted
recordsFailed
```

A record counts as persisted only if its page successfully commits the full M6 persistence pipeline:

```text
SourceRecord
+
NormalizedShipment
```

Therefore a page rollback caused by canonical persistence still counts the page records as failed according to existing M3 semantics.

Document this clarification.

---

# 24. Historical semantics

Repeated runs remain historical.

Example:

```text
Run #10

SourceRecord
SHP-100
status = IN_TRANSIT

NormalizedShipment
shipmentKey = SHP-100
status = IN_TRANSIT
```

Later:

```text
Run #11

SourceRecord
SHP-100
status = DELIVERED

NormalizedShipment
shipmentKey = SHP-100
status = DELIVERED
```

Both normalized observations must remain.

Do not update the previous normalized row.

---

# 25. No current-state table

Do NOT create:

```text
shipments
current_shipments
shipment_latest_state
```

during M6.

M6 creates canonical historical observations.

A current-state projection can be considered later only if required.

---

# 26. Database constraints

At minimum test database enforcement for:

```text
source_record_id required
source_record_id FK
source_record_id unique
canonical status CHECK
shipment_key required
amount required
```

Use RESTRICT deletion semantics consistent with the existing historical model.

Do not introduce cascade deletion of audit history.

---

# 27. Indexes

Add only indexes justified by known future access.

A useful candidate is:

```text
shipment_key
```

because M7 will match canonical observations by shipment key.

Do not add speculative indexes for every column.

The unique source_record_id constraint already provides its own uniqueness/index semantics.

---

# 28. SourceRecord relationship

Update the model so application code can load:

```ts
sourceRecord.normalizedShipment
```

and:

```ts
normalizedShipment.sourceRecord
```

Use current AdonisJS 7 / Lucid conventions.

Do not manually edit generated schema files.

Regenerate them using the project's established workflow.

---

# 29. Carrier synchronization test

A successful Carrier synchronization must now create:

```text
3 SourceRecords
3 NormalizedShipments
```

Example SHP-100:

Raw:

```json
{
  "shipmentId": "SHP-100",
  "status": "IN_TRANSIT",
  "amount": 1250.5
}
```

Canonical:

```text
shipmentKey = SHP-100
status = IN_TRANSIT
amount = 1250.50
```

Verify raw payload remains unchanged.

---

# 30. TMS synchronization test

A successful TMS synchronization must create:

```text
3 SourceRecords
3 NormalizedShipments
```

Example:

Raw:

```json
{
  "shipmentCode": "SHP-100",
  "status": "FINALIZADO",
  "totalValue": 1250.5,
  "deliveryDate": "2026-10-04"
}
```

Canonical:

```text
shipmentKey = SHP-100
status = DELIVERED
amount = 1250.50
```

Verify raw TMS fields remain unchanged.

---

# 31. Cross-provider canonical equivalence

Add a test proving that two structurally different raw observations may normalize to equivalent business values.

For example:

Carrier:

```text
shipmentId = SHP-100
status = DELIVERED
amount = 1250.50
```

TMS:

```text
shipmentCode = SHP-100
status = FINALIZADO
totalValue = 1250.50
```

Canonical projections should both contain:

```text
shipmentKey = SHP-100
status = DELIVERED
amount = 1250.50
```

Do NOT compare them and create a reconciliation result yet.

The test proves canonical equivalence only.

---

# 32. Unknown status tests

Carrier:

```text
status = NEW_CARRIER_STATE
```

must produce:

```text
UNKNOWN
```

TMS:

```text
status = EM_SEPARACAO
```

must also produce:

```text
UNKNOWN
```

Raw payloads retain the exact original strings.

Synchronization should still succeed when all other fields are valid.

---

# 33. Persistence atomicity test

Create a deterministic test that forces canonical persistence to fail within a page.

Verify:

```text
all SourceRecords from that page rolled back
all NormalizedShipments from that page rolled back
previous pages remain committed
SyncRun counters remain consistent
terminal status follows M3 rules
```

Do not weaken the existing duplicate-page rollback tests.

---

# 34. Historical normalization test

Execute the same provider twice with different statuses.

Verify:

```text
two SourceRecords
two NormalizedShipments
```

for the same shipment key across separate runs.

The first canonical projection must not be updated.

---

# 35. Queue/worker regression

The unchanged generic:

```text
SyncIntegrationJob
```

must continue working.

Carrier asynchronous execution:

```text
POST
→ 202
→ Queue
→ Worker
→ SyncEngine
→ raw + normalized Carrier observations
```

TMS asynchronous execution:

```text
POST
→ 202
→ Queue
→ Worker
→ SyncEngine
→ raw + normalized TMS observations
```

Do not add a normalization job.

Normalization is part of the current synchronization pipeline in M6.

---

# 36. Reconciliation is explicitly forbidden

Do NOT create:

```text
Reconciliation
Discrepancy
STATUS_MISMATCH
VALUE_MISMATCH
MISSING_IN_CARRIER
MISSING_IN_TMS
```

Do not compare Carrier rows against TMS rows in production code.

M7 owns that responsibility.

M6 only makes such comparison possible.

---

# 37. No provider contract redesign

Do not modify Carrier/TMS mocks merely to make canonical normalization easier unless a genuine correctness defect exists.

In particular:

```text
Carrier.updatedAt
```

must not be reinterpreted as a delivery timestamp.

Provider contracts stay provider-specific.

---

# 38. Documentation

Create:

```text
docs/normalization.md
```

Document:

- why raw and normalized records coexist;
- canonical historical observation semantics;
- canonical fields;
- status mappings;
- UNKNOWN semantics;
- amount representation;
- why delivery date is deferred;
- normalizer boundary;
- relationship to Connector;
- page atomicity;
- historical behavior;
- what M7 will consume without implementing M7.

Update relevant architecture documentation concisely.

Update:

```text
docs/roadmap.md
```

after implementation so:

```text
M6 ✅
M7 NEXT
```

only when M6 has actually passed validation.

Create:

```text
docs/m6-validation.md
```

with observed evidence.

---

# 39. Migration validation

Run the normal database migration lifecycle used by this repository.

Validate:

```text
migration apply
rollback
apply
```

against the isolated test database as appropriate.

Confirm generated schema consistency.

Do not manually edit generated schema.

---

# 40. Test requirements

Run all existing suites plus new M6 tests.

Preserve:

```text
M0
M1
M2
M3
M4
M5
```

behavior.

New M6 coverage should include at minimum:

```text
Carrier normalizer
TMS normalizer
all known status mappings
UNKNOWN mapping
amount mapping
raw preservation
model relationships
database status CHECK
FK / uniqueness
Carrier full synchronization
TMS full synchronization
cross-provider canonical equivalence
page atomicity
historical normalized observations
async worker regression
```

---

# 41. Validation requirements

Before completion, run and record:

```text
npm test
npm run lint
npm run typecheck
npm run format:check
npm run build
```

plus relevant migration, Docker and asynchronous integration checks.

Validate the production Docker image and Compose configuration.

Verify:

```text
api
worker
postgres
redis
carrier-mock
tms-mock
```

still operate correctly.

---

# 42. No unrelated dependency work

Do not upgrade:

```text
AdonisJS
Lucid
Queue
Redis package
Node
```

during M6.

Do not attempt to fix existing npm audit findings as part of this milestone.

Keep dependency/security work separate.

---

# 43. Expected architecture after M6

```text
Carrier API
   ↓
CarrierClient
   ↓
CarrierConnector ───────────┐
                            │
                            ▼
                         SyncEngine
                            │
                            │ page transaction
                            │
                   ┌────────┴────────┐
                   ▼                 ▼
             SourceRecord     NormalizedShipment
                 raw              canonical
                   ▲                 ▲
                   │                 │
                            │
                         SyncEngine
                            ▲
                            │
TmsConnector ───────────────┘
   ↑
TmsClient
   ↑
TMS API
```

More simply:

```text
raw provider observation
        ↓
SourceRecord
        +
canonical projection
        ↓
NormalizedShipment
```

---

# 44. M7 handoff

At the end of M6 the system should be capable of storing:

```text
Carrier normalized:
SHP-100 / DELIVERED / 1250.50

TMS normalized:
SHP-100 / DELIVERED / 1250.50
```

or:

```text
Carrier:
SHP-100 / DELIVERED / 1250.50

TMS:
SHP-100 / IN_TRANSIT / 1300.00
```

But M6 must not decide whether those values match.

M7 will own reconciliation and discrepancy creation.

---

# 45. Suggested commits

Because this milestone includes a schema change, normalization domain and SyncEngine integration, prefer coherent commits if the implementation naturally separates.

Acceptable example:

```text
feat: add canonical shipment normalization
```

A split is also acceptable if independently valid:

```text
feat: add normalized shipment persistence

feat: integrate shipment normalization into sync engine
```

Do not split merely to increase commit count.

Do not mix the durable Codex-context bootstrap commit into M6.

---

# 46. Completion report

When finished, report:

1. files created;
2. files modified;
3. migration/schema changes;
4. NormalizedShipment model;
5. canonical fields;
6. Carrier status mapping;
7. TMS status mapping;
8. UNKNOWN behavior;
9. exact amount representation decision;
10. normalizer architecture;
11. SyncEngine integration;
12. page atomicity behavior;
13. model relationships;
14. tests added;
15. complete test totals;
16. migration validation;
17. async Carrier result;
18. async TMS result;
19. Docker/build validation;
20. issues encountered;
21. unresolved tradeoffs;
22. confirmation that no reconciliation/M7 functionality was implemented.

Do not start M7.
