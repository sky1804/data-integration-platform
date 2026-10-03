# Data Integration & Reconciliation Platform

M0: an API-only AdonisJS 7 foundation on Node.js 24. There are no domain models,
connectors, jobs, schedules, authentication, or frontend. Later milestones require
an explicit architectural review before implementation.

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
npm run dev
```

Run `npm run worker` in a separate terminal when needed. Avoid starting a local
API and the Compose API on the same port.

For container development with HMR and filesystem polling:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up --build
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

With PostgreSQL and Redis running:

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

Japa functional tests exercise the HTTP response, PostgreSQL `SELECT 1` via Lucid,
and Redis `PING` via `@adonisjs/redis`. They do not create tables or modify data.
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
- Lucid uses PostgreSQL and the `pg` driver. No migrations or models are defined.
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
