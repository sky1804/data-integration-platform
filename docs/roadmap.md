# Project roadmap

Current implemented state: M0–M6. M7 is next and requires an explicit request
before implementation begins.

The [M6 milestone](milestones/m6-normalization.md) defines its implemented scope;
see [normalization](normalization.md) and [validation](m6-validation.md).

## Milestones

- M0 ✅ Infrastructure
- M1 ✅ Persistence and historical raw observations
- M2 ✅ Carrier HTTP provider
- M3 ✅ SyncEngine
- M4 ✅ Redis Queue / Worker asynchronous execution
- M5 ✅ TMS provider + Connector abstraction

- M6 ✅ Canonical shipment normalization
- M7 NEXT — Reconciliation and discrepancies
- M8 — Resilience / idempotency / retries / locks / recovery
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
```

`POST /integrations/:id/sync` queues an integration ID for a separate worker.
SyncEngine manages pagination, page transactions, progress, and audit outcomes.
Connectors adapt ingestion metadata and pagination; clients handle provider HTTP.
PostgreSQL stores SyncRun audit records and complete raw SourceRecord payloads.
Separate provider normalizers produce historical canonical projections in the
same page transaction, preserving the raw observations.

**Business normalization is implemented; reconciliation has not yet been implemented.**
Raw provider fields remain unchanged. There is no current-state shipment table
or discrepancy processing.

## Focused implementation context

Use [milestone files](milestones/README.md) for scoped implementation context and
read only directly relevant architecture documents:

- [Persistence and lifecycle](sync-lifecycle.md)
- [SyncEngine](sync-engine.md)
- [Asynchronous execution](async-sync.md)
- [Connector boundary](connectors.md)
- [Canonical normalization](normalization.md)
- [Carrier provider](carrier-provider.md) and [TMS provider](tms-provider.md)

Existing `docs/m0-validation.md` through `docs/m5-validation.md` remain unchanged
historical evidence. Detailed contracts and validation results stay in those
existing documents rather than being duplicated here.
