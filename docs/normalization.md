# Canonical shipment normalization — M6

Each newly ingested SourceRecord has one NormalizedShipment historical projection.
Raw payloads remain complete and unchanged. A later synchronization creates a new
raw/projection pair, even for the same shipment key; no previous projection is
updated. There is no current-state shipment table.

## Fields and relationships

`normalized_shipments` stores `id`, `source_record_id`, `shipment_key`, `status`,
`amount`, and `created_at`. SourceRecord hasOne NormalizedShipment;
NormalizedShipment belongsTo SourceRecord. Its source foreign key is required,
unique, and uses ON DELETE RESTRICT. A CHECK constraint enforces the canonical
status set; required business fields are NOT NULL. `shipment_key` is indexed for
the planned reconciliation matching access.

The migration adds an empty table. Existing pre-M6 SourceRecords may have no
projection; there is no backfill. The foreign key/unique constraint guarantees
valid linkage and at most one projection, while SyncEngine's transaction creates
exactly one for each observation committed through its M6 ingestion path.
Direct SourceRecord model writes remain possible for historical data and tests.

## Provider mapping

| Canonical field | Carrier source       | TMS source           |
| --------------- | -------------------- | -------------------- |
| shipmentKey     | shipmentId           | shipmentCode         |
| status          | status mapping below | status mapping below |
| amount          | amount               | totalValue           |

Keys retain the provider value exactly; M6 adds no trimming, case conversion,
composite keys, or speculative matching rules. The envelope's externalId remains
the source-system identifier, separate from the business matching key.

| Carrier status   | TMS status       | Canonical status |
| ---------------- | ---------------- | ---------------- |
| PENDING          | CRIADO           | PENDING          |
| IN_TRANSIT       | EM_TRANSITO      | IN_TRANSIT       |
| DELIVERED        | FINALIZADO       | DELIVERED        |
| CANCELED         | CANCELADO        | CANCELED         |
| Any other string | Any other string | UNKNOWN          |

Unknown statuses succeed without guessing a known status or failing ingestion.
The exact original string remains in the raw payload. Mapping is case-sensitive.

## Exact decimal persistence

PostgreSQL uses `numeric(15,2)`, allowing up to 13 integer digits and two decimal
places: -9,999,999,999,999.99 through 9,999,999,999,999.99. Negative values remain
allowed because the current contracts accept finite amounts without a positivity
rule. A database CHECK rejects numeric NaN; numeric precision rejects overflow.

Both normalizers use the same small conversion function. It inspects the shortest
decimal representation of the already parsed JavaScript number, rejects extra
fractional digits or overflow, and pads to two decimal places without rounding or
floating-point arithmetic. For example, 1250.5 becomes the string `1250.50`, while
1.005 and 0.30000000000000004 fail. Lucid's generated schema and PostgreSQL driver
both expose decimal amounts as strings. No money dependency or Number conversion
is added at the persistence boundary.

This preserves the parsed provider value, not the original JSON numeric spelling
or precision already lost in JSON.parse. SourceRecord retains JSON structure,
not the original HTTP bytes. PostgreSQL itself can round direct SQL writes to a
scaled numeric column; the no-rounding guard applies to the ingestion path before
persistence. Other future write paths must use equivalent validation.

An unrepresentable amount is a real `NormalizationError`, translated to fixed,
sanitized `NORMALIZATION_ERROR` audit fields. Unknown statuses never use this code.
No amount, raw body, credentials, database detail, or caught exception text is
included in the public/audit message.

## Ownership and atomicity

Provider clients own HTTP and schema validation. Connectors keep their unchanged
raw ingestion envelope. Pure provider normalizers under `app/normalization/` map
business fields without HTTP, persistence, mutation, or reconciliation. Their
two-case factory consumes the existing SupportedProvider type.

SyncEngine resolves the normalizer for the integration's provider. In its existing
page transaction, it normalizes each observation, creates its SourceRecord, then
creates its linked NormalizedShipment. The same transaction updates run progress.
HTTP stays outside the transaction. No extra job or nested transaction is added.

If normalization or canonical persistence fails, the whole page rolls back,
including earlier raw/projection pairs within that page and progress updates.
Earlier committed pages remain. `recordsPersisted` counts only committed pairs;
`recordsFailed` counts every observation in the rolled-back page. Existing
SUCCESS/PARTIAL/FAILED rules and received = persisted + failed semantics remain.
Canonical database insert failures retain sanitized PERSISTENCE_ERROR handling.

## Deferred semantics

Currency is absent because neither contract supplies it. Delivery date remains
raw: TMS deliveryDate and Carrier updatedAt describe different events. There is
no delivery-date mapping, alerting, retry, lock, recovery, or reconciliation here.

M7 can consume historical projections, follow SourceRecord → SyncRun → Integration
for provenance, and match shipmentKey. Choosing observations to compare and
creating discrepancies belong to M7. See [SyncEngine](sync-engine.md),
[connectors](connectors.md), and [M6 validation](m6-validation.md).
