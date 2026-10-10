# Data Integration & Reconciliation Platform

An API-only AdonisJS 7 application on Node.js 24. M0 established the infrastructure;
M1 adds `Integration`, `SyncRun`, and historical `SourceRecord` persistence.
There are no connectors, jobs, schedules, authentication, or frontend. See
[the synchronization lifecycle](docs/sync-lifecycle.md) for M1 decisions.

## Quick start

Requires Docker Engine/Desktop with Linux containers and Docker Compose v2.
From this directory:

```sh
cp .env.example .env
docker compose up --build
```

PowerShell: use `Copy-Item .env.example .env` for the first command.
The API is at <http://localhost:3333/> and returns JSON. The worker runs
`node ace.js queue:work` in a separate container using the same production image.
An idle worker is expected because M0 defines no jobs.
The package's "No jobs found" startup warning is expected at this milestone.

After the services start, apply the M1 tables from a second terminal:

```sh
docker compose exec -T api node ace.js migration:run --force --no-schema-generate
```

Startup does not run migrations automatically. This command targets the normal
application database; tests use a separate database described below.

PostgreSQL and Redis have health checks; both application services wait for healthy
dependencies. Database and Redis data persist in named volumes. Published ports
are bound to localhost. Stop the stack with `docker compose down` (retains data).
If a host port is occupied or blocked, change its value in `.env`; for example,
use `DB_PORT=55432`. The internal PostgreSQL port remains 5432.

The example credentials and application key are public development defaults.
For deployment, supply private credentials and a new key generated with
`node ace generate:key`; configure the environment independently of the image.
The bundled Redis service is an unauthenticated local development service, so
leave `REDIS_PASSWORD` empty when using this Compose stack.

## Local development

Requires Node.js 24 and npm 11 or later. `.env.example` uses localhost for database
and Redis connections; Compose overrides these hosts with internal service names.

```sh
npm ci
docker compose up -d postgres redis
node ace migration:run
npm run dev
```

Run `npm run worker` in a separate terminal when needed. Avoid starting a local
API and the Compose API on the same port.

For container development with HMR and filesystem polling:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

Apply development migrations from a second terminal:

```sh
docker compose -f compose.yaml -f compose.dev.yaml exec -T api node ace migration:run
```

The development commands use `node ace serve --hmr --poll`. HMR reloads supported
modules, and polling detects source changes across Docker bind mounts, as described
in the [AdonisJS command reference](https://docs.adonisjs.com/reference/commands#serve).

This uses the Dockerfile's development stage and mounts the source. Linux
dependencies have separate named volumes, so host `node_modules` are not used.
Restart the worker after source changes. After changing dependencies, refresh
them with `docker compose -f compose.yaml -f compose.dev.yaml exec api npm ci`
and the equivalent command for `worker`.

## Verification

With PostgreSQL and Redis running, create the isolated test database once:

```sh
docker compose exec -T postgres createdb -U platform data_integration_test
```

Use your configured `DB_USER` and `DB_TEST_DATABASE` if they differ from the
example. An existing database does not need to be recreated. Tests automatically
select `DB_TEST_DATABASE` when `NODE_ENV=test`; no `.env.test` file is required.
The test database must end in `_test` and differ from `DB_DATABASE`.

Then run:

```sh
npm test
npm run lint
npm run typecheck
npm run format:check
npm run build
docker build --target production -t data-integration-platform:production .
docker compose ps
docker compose logs api worker
```

Japa retains the M0 HTTP/PostgreSQL/Redis bootstrap checks and adds M1 persistence,
relationship, default, uniqueness, foreign-key, and JSONB history checks. Runner
setup migrates the test database and cleanup resets all its applied migrations. Each
persistence test runs in a global transaction rolled back after the test.
Development data is not used by tests. See [test isolation](docs/sync-lifecycle.md#test-isolation).
The test database is disposable; do not share it with unrelated data or concurrent
test runs.
Tests start their own HTTP server; run them with the API stopped or with another
`PORT`, for example `PORT=3334 npm test` (PowerShell: `$env:PORT=3334; npm test`).

Tests can also run in the development image, without installing Node.js locally:

```sh
docker compose -f compose.yaml -f compose.dev.yaml run --rm --build --no-deps api npm test
```

Start the infrastructure first. `run` does not publish the API service ports.
The production image intentionally omits development dependencies and test tooling.

## Bootstrap decisions

- The [slim starter linked by the AdonisJS 7 documentation](https://docs.adonisjs.com/installation)
  supplies the conventional single-application structure. The official API starter
  includes frontend and authentication scaffolding outside M0's scope.
- Lucid uses PostgreSQL and the `pg` driver. M1 models extend its generated schema
  classes. Run `node ace migration:run` for development or
  `docker compose exec api node ace.js migration:run --force --no-schema-generate`
  for the compiled Compose application. Schema generation belongs to the
  development workflow; the production container consumes the committed schema.
- Queue uses the named `main` Redis connection and runs in a separate process,
  following the [current Queue guide](https://docs.adonisjs.com/guides/digging-deeper/queues).
  `@adonisjs/queue` is pinned to **0.6.2** because its API is experimental.
  Redis **10.0.2** satisfies Queue's supported peer range and AdonisJS 7's peer range;
  Redis 11 is outside Queue 0.6.2's declared peer range.
- The generated scheduler preload is empty; no schedules or jobs are registered.
  Queue and worker defaults are retained. Retry policies and processing semantics
  are deferred to later milestones.
- [AdonisJS's standalone build](https://docs.adonisjs.com/deployment) is copied into
  a Node.js 24 Debian Bookworm slim runtime with only production dependencies.
  Both application services share this image. The runtime runs as the `node` user;
  Compose supplies an init process and a 30-second shutdown grace period.
- PostgreSQL 17 and Redis 7.4 use Debian-based images and named data volumes.
  No automatic migrations run on startup.
- Environment values are validated in `start/env.ts`, including the Redis-only
  queue driver. ESLint, Prettier, Japa, and the framework's logger configuration
  use the starter conventions. The root JSON route is only a bootstrap response;
  application health endpoints and observability work remain deferred.

See [the M0 validation record](docs/m0-validation.md) for executed checks.
See [the M1 completion and validation record](docs/m1-validation.md) for persistence
files, constraints, isolation, tests, commands, and remaining tradeoffs.
See [the dependency security review](docs/dependency-security.md) for the dated npm
audit, affected packages, and available remediation status.
