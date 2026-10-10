# M2 — completion and validation

Validation date: 2026-10-10. Local Node.js 24.11.1 / npm 11.6.4; Docker Desktop
with Linux containers. Existing package versions and lockfile were inspected and
retained, including AdonisJS 7, Lucid 22.4.2, Redis 10.0.2, and pinned Queue 0.6.2.

## Scope and files

M2 adds the Carrier HTTP boundary without connecting it to M1 persistence.
Models, migrations, generated database schema, API routes, and queue jobs were
not changed. No npm dependencies were added.

Created:

- `app/integrations/carrier/carrier_client.ts`: concrete single-page native-fetch client.
- `app/integrations/carrier/carrier_types.ts`: raw shipment, page, request and client options.
- `app/integrations/carrier/carrier_validator.ts`: validation of untrusted provider JSON.
- `app/integrations/carrier/carrier_errors.ts`: explicit Carrier error classes.
- `config/carrier.ts`: validated provider configuration with a secret token.
- `mocks/carrier/server.ts` and `mocks/carrier/Dockerfile`: separate deterministic HTTP provider.
- `tests/unit/carrier_client.spec.ts` and `tests/unit/carrier_validator.spec.ts`: 46 Carrier tests.
- `docs/carrier-provider.md` and this validation record.

Modified for M2:

- `.env.example` and the ignored local `.env`: Carrier URL, demo token, timeout.
- `start/env.ts`: required Carrier variables and URL/deadline constraints.
- `compose.yaml`: fifth service, localhost port 4001, mock health check, internal application URL.
- `tests/bootstrap.ts`: migration setup/cleanup belongs to the functional suite;
  running only Carrier unit tests does not migrate a database.
- `README.md` and `docs/sync-lifecycle.md`: M2 usage and current test isolation/deferred scope.

Earlier documentation review changes in README, lifecycle, M0/M1 validation and
`docs/dependency-security.md` were already present before M2 and were preserved.
They are independent of this feature. The existing application Dockerfile and
development Compose override remain unchanged.

## Architecture and public API

The mock is a separate Node.js 24 HTTP process, running as a non-root user, with
no npm dependencies, PostgreSQL/Redis clients, credentials, or data volumes. Its
fixtures are fixed. `/health` does not require authentication; `/shipments`
requires the configured Bearer token. Controlled query scenarios are development
utilities: normal, unauthorized, rate-limit, server-error, invalid-payload, slow.

`new CarrierClient()` uses `config/carrier.ts`; optional constructor settings
allow isolated test servers. `fetchPage({ cursor?, limit? })` returns
`{ records: CarrierShipment[], nextCursor: string | null }`. It makes one request
and exposes no scenario control, page loop, retries, normalization or persistence.
The mock defaults to limit 2; callers keep the same limit across pages and treat
the returned cursor as opaque. Limits are 1–100.

Native fetch and AbortSignal deadlines apply through body reading. Redirects are
rejected. A small validator checks all required fields, finite numeric amounts,
nonblank IDs, ISO timestamps with timezones/calendar validity, and pagination.
Raw status, timestamp strings, and extra fields are retained. Existing Luxon
checks dates; explicit numeric bounds reject invalid timezone/time components.
Invalid JSON or any invalid record rejects the page.

Authentication errors map 401/403; rate limit maps 429; unavailable maps 5xx and
transport errors; timeout maps an expired deadline; payload validation maps HTTP
200 invalid JSON/schema; request errors map other statuses. Error messages omit
provider body values, tokens, URLs, and low-level exception details. HTTP status
is retained where available. See [the provider guide](carrier-provider.md) for
the exact classes and environment variables.

API/worker startup still depends only on healthy PostgreSQL/Redis. The mock's
health is independently monitored, reflecting that a real external provider is
not part of application startup. Compose uses `http://carrier-mock:4001`; local
Node development uses `http://127.0.0.1:4001`.

## Tests and commands executed

Carrier tests use ephemeral loopback HTTP servers and the actual mock handler,
without Lucid/model imports or database writes. Coverage includes endpoint,
authorization header, default and custom pagination, raw data preservation,
opaque cursor encoding, constructor/request validation, missing/invalid auth,
401/403/429/500/503, unexpected status/redirects, malformed JSON, bad payloads,
timeouts before headers and during body reading, interrupted responses, and
exactly one request on failures. Validator cases cover empty pages, offsets,
unknown statuses, extra fields and malformed fields/dates/cursors.

Commands executed from the project root:

```sh
node --version
npm --version
git status --short
git branch --show-current
docker compose up -d postgres redis carrier-mock
node ace test unit
npm test
npm run lint
npm run typecheck
npm run format:check
npm run build
docker compose up --build -d
docker compose config --quiet
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose ps
docker compose logs --tail 6 api worker carrier-mock
docker compose exec -T redis redis-cli ping
```

Used `PORT=3334` for the full local test suite to avoid the running Compose API.
Also ran Carrier-only tests with `DB_PORT=1` and `REDIS_PORT=1` to demonstrate
that unavailable infrastructure does not block them. Restored those process
overrides afterward. The first run had 42 Carrier tests; final regression cases
bring the total to 46.

Ran native Node assertions via stdin in the production API container:
`docker compose exec -T api node --input-type=module -`. Imported the compiled
CarrierClient and configuration, called its default-configured client for both
pages, and verified the root API, mock health, authentication, and all controlled
mock scenarios over Compose DNS. Checked invalid mock payloads through the
compiled validator and aborted the slow scenario with a deadline. Additional
startup validation checks rejected invalid Carrier timeout, URL and empty token.

Inspected development table counts before and after tests/manual execution using
`docker compose exec -T postgres psql -U platform -d data_integration`, and
inspected public test database tables after functional-suite cleanup. No M2
execution created synchronization records. Existing M1 tests create only their
isolated transactional fixtures, which are rolled back.

## Results

| Check                                              | Result                                               |
| -------------------------------------------------- | ---------------------------------------------------- |
| M0 functional tests                                | Passed: 3/3                                          |
| M1 persistence tests                               | Passed: 17/17                                        |
| M2 Carrier tests                                   | Passed: 46/46                                        |
| Full suite                                         | Passed: 66/66                                        |
| Carrier-only tests with unavailable infrastructure | Passed; no migrations or database writes             |
| Lint, typecheck, format check                      | Passed                                               |
| Production application build                       | Passed                                               |
| Production Docker image build                      | Passed through Compose's production target           |
| Default/development Compose configuration          | Passed                                               |
| API/worker startup                                 | Running; API JSON HTTP 200, worker polls separately  |
| PostgreSQL/Redis                                   | Healthy; Redis PONG                                  |
| Carrier mock                                       | Running and healthy; `/health` returns expected JSON |
| Configured compiled client reaches Compose mock    | Passed; SHP-100/101 then SHP-102, final cursor null  |
| Auth, 429, 500, invalid payload, slow scenario     | Passed                                               |
| Carrier environment validation                     | Invalid URL, timeout, empty token rejected           |
| Development synchronization table counts           | Zero before and after in all three tables            |
| Isolated test database cleanup                     | Only Lucid migration metadata tables remain          |

## Issues and remaining tradeoffs

Docker was stopped at the start; starting the installed Docker Desktop enabled
container validation. Initial lint findings were corrected to `Number.NaN`.
Luxon accepts some out-of-range timezone offsets, so the timestamp validator
also constrains numeric time/offset components and has regression tests. There
are no unresolved M2 implementation failures.

The existing Queue provider initializes Redis during Adonis test application
boot. With unreachable Redis it logs connection failures, but the Carrier-only
suite passes without infrastructure. Provider boot behavior was retained rather
than redesigning M0. The no-jobs warning remains expected.

Production image installation still reports 13 high-rated affected package
entries; the full dependency install reports 17. These are existing locked
dependencies, previously traced to `braces@3.0.3`; see the dated
[dependency security review](dependency-security.md). M2 adds no packages and
does not force dependency downgrades. The local PostgreSQL port remains 55432.

The mock's page cursors assume a stable limit and dataset. No retry decisions,
rate-limit delay parsing, bounded response-size policy, or generic connector
abstraction is implemented in this milestone. The demo service belongs to local
development/testing, even when the application uses its production image.

No M3 functionality was implemented. Synchronization orchestration, persistence
from Carrier, jobs, schedules, locks, backoff, normalization, TMS, reconciliation,
API authentication, frontend, and CI/CD remain deferred.
