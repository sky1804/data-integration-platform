# Asynchronous synchronization — M4

```text
POST /integrations/:id/sync → Redis Queue → separate worker
                                               ↓
                                     SyncIntegrationJob
                                               ↓
                                          SyncEngine
                                               ↓
                                  Connector + PostgreSQL
```

The request waits for enqueue acknowledgement, not synchronization. M3's engine
still owns execution validation, new SyncRun creation, lifecycle, pagination,
transactions, counters and raw persistence. The controller and job contain none
of that orchestration.

## Endpoint and responses

`IntegrationSyncsController.store` handles only `POST /integrations/:id/sync`.
It validates a canonical positive decimal ID within the existing PostgreSQL
integer ID range, loads the integration, checks enabled/provider, then awaits
`SyncIntegrationJob.dispatch({ integrationId }).run()`.

```json
{
  "status": "queued",
  "integrationId": 123,
  "jobId": "package-issued-job-id"
}
```

This body uses HTTP 202. Queue 0.6.2's `DispatchResult.jobId` is returned directly;
the application does not generate an ID or return a SyncRun ID. There is no
job-status or SyncRun-status endpoint in M4.

Errors consistently use `{ "error": { "code": "...", "message": "..." } }`:

| Condition                                  | HTTP | Code                      |
| ------------------------------------------ | ---- | ------------------------- |
| Invalid ID, including out-of-range integer | 400  | `INVALID_INTEGRATION_ID`  |
| Integration missing                        | 404  | `INTEGRATION_NOT_FOUND`   |
| Integration disabled                       | 409  | `INTEGRATION_DISABLED`    |
| Provider other than `carrier` / `tms`      | 422  | `UNSUPPORTED_PROVIDER`    |
| Integration lookup unavailable             | 503  | `INTEGRATION_UNAVAILABLE` |
| Queue push rejected/unavailable            | 503  | `QUEUE_UNAVAILABLE`       |

Messages are sanitized and contain no stack trace, Redis connection details or
database error text. The endpoint is currently unauthenticated. Authentication,
authorization and integration CRUD are later concerns.

Prevalidation improves feedback, but SyncEngine validates again during worker
execution. Integrations can change or disappear while a job waits. A job accepted
while enabled can therefore fail later because its integration was disabled.

## Job and pinned package APIs

`SyncIntegrationJob extends Job<{ integrationId: number }>` contains just:

```ts
async execute() {
  await new SyncEngine().execute(this.payload.integrationId)
}
```

M5 keeps this class and payload unchanged. The worker loads Integration and the
engine resolves CarrierConnector or TmsConnector from its current provider; no
provider field is trusted from the queue payload. Both use this same endpoint and
job. It catches no engine exception. SUCCESS completes the queue job; any engine
exception fails it. Business audit finalization remains the engine's task.

M6 keeps this same job and payload. Inside SyncEngine, each successful page now
commits raw SourceRecords and linked canonical projections together. See
[normalization](normalization.md); no separate normalization job is introduced.

Installed `@adonisjs/queue` stays pinned to **0.6.2**, with locked underlying
`@boringnode/queue` **0.6.0**. Implementation follows the installed declarations,
job stub and worker source; this experimental API may differ from newer docs.
Job options are `queue: 'default'` and explicit `maxRetries: 0`. No backoff,
retry delay, Retry-After policy or manual reprocessing is configured. Retrying an
engine execution would create another SyncRun and needs a deliberate future
idempotency design.

The pinned adapter normally removes finished jobs immediately. Job options retain
at most 100 completed and 100 failed entries in the queue history, enabling
infrastructure inspection without unbounded history. These are temporary Redis
records, distinct from the PostgreSQL business audit; retention is not a durable
queue-to-run link.

## Queue state is not SyncRun state

Queue's actual stored states include `pending`, `active`, `completed`, and
`failed` (conceptually queued/processing/completed/failed). SyncRun uses
`PENDING`, `RUNNING`, `SUCCESS`, `PARTIAL`, and `FAILED`.

| Event                                 | HTTP                 | Queue job      | SyncRun           |
| ------------------------------------- | -------------------- | -------------- | ----------------- |
| Enqueued, worker has not started      | 202                  | pending        | May not exist yet |
| Successful synchronization            | 202 already returned | completed      | SUCCESS           |
| Provider fails before stored records  | 202 already returned | failed         | FAILED            |
| Provider fails after a committed page | 202 already returned | failed         | PARTIAL           |
| Queue unavailable before enqueue      | 503                  | No job created | No run created    |

The controller enqueues only an integration ID. Engine-created PENDING means a
worker has invoked execution, not that an HTTP request is waiting in Redis.
There is no `queue_job_id`, `queued_at`, or queue-status column on SyncRun.

A fast worker can finish before a client receives its 202 response. The guarantee
is that the HTTP handler never awaits engine execution, not a strict ordering of
client response delivery and worker completion.

## Worker and execution limitations

Existing discovery `./app/jobs/**/*.{ts,js}` finds the job in source and compiled
builds. The worker uses the existing `node ace queue:work` command locally and
`node ace.js queue:work` in production Compose. Concurrency remains **5** and
idle delay remains **2s**. `QUEUE_DRIVER=redis` and the existing Redis connection
remain unchanged; no inline production adapter or custom worker loop is used.

Two accepted requests can enqueue two jobs and create independent historical
runs. No `dedup`, lock, distributed mutex or single-flight restriction exists.
No synchronization is registered in `start/scheduler.ts`.

A worker crash can leave a RUNNING run. Queue's stalled-job mechanics do not
define business recovery or guarantee exactly-once synchronization. Zero retries
disables automatic retry after reported execution failures; it is not a promise
that stalled delivery can never happen again. A lost enqueue acknowledgement can
also make delivery uncertain. Recovery, duplicate suppression and stale-run
handling remain deferred.

## Manual use and tests

With an enabled Carrier integration already present in PostgreSQL:

```sh
docker compose up --build -d
curl -X POST http://127.0.0.1:3333/integrations/123/sync
docker compose logs --tail 20 worker
```

PowerShell users can use `curl.exe`. Substitute the integration's ID. This does
not add an integration creation endpoint. The returned job ID can be inspected
from application/debug code with the pinned package's
`queue.use().getJob(jobId, 'default')`; M4 adds no public status endpoint.

```sh
npm test
npm run test:async
```

The regular suite uses `queue.fake()` and restores it after every dispatch test.
It verifies enqueue payloads, errors, distinct duplicate jobs, no dispatch-time
SyncRun and no inline provider execution. Job tests use the official underlying
FakeAdapter and `Worker.processCycle`, then restore the original manager config,
adapter, job factory and discovery. Ephemeral Carrier/TMS HTTP servers keep
these tests independent of a running Compose mock. M1's isolation is unchanged;
worker tests use M3's guarded test-database truncation strategy.

`test:async` is a separate Docker check requiring the production image and healthy
Compose infrastructure. It creates a unique `_test` database, a disposable Redis
container, an API on a random localhost port, and separate workers. It first
obtains 202 while no worker exists and verifies a real Redis pending job with no
run. It then proves completion for both providers, different raw schemas for
SHP-100, provider failure and queue outage behavior.
Only resource IDs created by that invocation are removed; its dedicated database
is dropped after process cleanup. It never flushes shared Redis or writes to
development tables, and checks development row counts before/after.

See [M4 validation](m4-validation.md) and [M5 validation](m5-validation.md) for executed results and
[SyncEngine](sync-engine.md) for the unchanged business execution semantics.
