# Project roadmap

Current implemented state: M0–M7. M8 is next and requires an explicit request
before implementation begins.

The [M7 milestone](milestones/m7-reconciliation.md) defines its implemented scope;
see [reconciliation](reconciliation.md) and [validation](m7-validation.md).

## Milestones

- M0 ✅ Infrastructure
- M1 ✅ Persistence and historical raw observations
- M2 ✅ Carrier HTTP provider
- M3 ✅ SyncEngine
- M4 ✅ Redis Queue / Worker asynchronous execution
- M5 ✅ TMS provider + Connector abstraction

- M6 ✅ Canonical shipment normalization
- M7 ✅ Reconciliation and discrepancies
- M8 NEXT — Resilience / idempotency / retries / locks / recovery
- M9 — Read/query REST API
- M10 — Test expansion
- M11 — CI/CD
- M12 — Architecture documentation / ADR polish

## Current architecture

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

SyncEngine
 ↓
SyncRun
 ↓
SourceRecord (raw historical observation)
 ↓
NormalizedShipment (canonical historical projection)

Explicit Carrier + TMS SUCCESS SyncRun IDs
 ↓
ReconciliationEngine (canonical observations only)
 ↓
ReconciliationRun
 ↓
Discrepancy
```

`POST /integrations/:id/sync` queues an integration ID for a separate worker.
SyncEngine manages pagination, page transactions, progress, and audit outcomes.
Connectors adapt ingestion metadata and pagination; clients handle provider HTTP.
PostgreSQL stores SyncRun audit records and complete raw SourceRecord payloads.
Separate provider normalizers produce historical canonical projections in the
same page transaction, preserving the raw observations.

Business normalization and explicit historical reconciliation are implemented.
Reconciliation compares exact canonical keys/statuses/amounts and atomically
records status/value mismatches and missing shipments. It is invoked separately
at service level; synchronization does not trigger it automatically. Raw provider
fields remain unchanged. There is no current-state shipment table or reconciliation
HTTP/queue entrypoint.

## Focused implementation context

Use [milestone files](milestones/README.md) for scoped implementation context and
read only directly relevant architecture documents:

- [Persistence and lifecycle](sync-lifecycle.md)
- [SyncEngine](sync-engine.md)
- [Asynchronous execution](async-sync.md)
- [Connector boundary](connectors.md)
- [Canonical normalization](normalization.md)
- [Historical reconciliation](reconciliation.md)
- [Carrier provider](carrier-provider.md) and [TMS provider](tms-provider.md)

Existing `docs/m0-validation.md` through `docs/m6-validation.md` remain unchanged
historical evidence. Detailed contracts and validation results stay in those
existing documents rather than being duplicated here.
