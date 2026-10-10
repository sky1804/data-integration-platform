# M0 validation

Validation date: 2026-10-01 (America/Sao_Paulo).

This is a historical M0 snapshot. Current persistence and test setup are described
in the README and M1 documents; current dependency findings are tracked in
[the dependency security review](dependency-security.md).

## Inspected before editing

The workspace was empty. Generated the documented slim starter with
`create-adonisjs@3.4.0`, then inspected its file tree, `package.json`, `adonisrc.ts`,
environment schema, test bootstrap, and installed versions before editing.

```sh
npm view create-adonisjs version
npm view @adonisjs/core version
npm view @adonisjs/queue version
npx --yes create-adonisjs@3.4.0 data-integration-platform --kit=github:batosai/adonisjs-slim-starter-kit --pkg=npm --skip-migrations
npm ls --depth=0
```

Final principal packages: core 7.5.2, Lucid 22.4.2, Redis 10.0.2, Queue 0.6.2,
Japa runner 5.3.0, TypeScript 5.9.3, ESLint 10.11.0, Prettier 3.9.9. Queue is
an exact dependency; the lockfile records all resolutions.

## Installation and configuration

```sh
npm install @adonisjs/lucid @adonisjs/redis pg
npm install @adonisjs/redis@^10.0.2
npm install --save-exact @adonisjs/queue@0.6.2
npm install --save-dev @types/node@^24 @japa/api-client
npm install luxon
npm install --save-dev @types/luxon
node ace configure @adonisjs/lucid --db=postgres --no-install
node ace configure @adonisjs/redis
node ace configure @adonisjs/queue
npm install --package-lock-only --offline --ignore-scripts
```

Selected Redis in Queue's configurator. The initial Queue installation failed
because Redis 11 is outside its supported peer range. Redis 10.0.2 resolved this
without bypassing peer checks. Removed duplicate environment entries appended
by the package configurators. Corrected two type-only imports flagged by lint.

## Results

| Required check                | Result                                                     |
| ----------------------------- | ---------------------------------------------------------- |
| Run application               | Passed: HTTP 200 and JSON at `/`                           |
| PostgreSQL connection         | Passed: Lucid `SELECT 1` test and direct `psql` query      |
| Redis connection              | Passed: configured client `PING` test and `redis-cli ping` |
| API container starts          | Passed: listens on `0.0.0.0:3333`                          |
| Worker container starts       | Passed: polls `default` queue and stays running            |
| Test suite                    | Passed: 3 tests locally and in Linux development container |
| Lint and typecheck            | Passed                                                     |
| Production application build  | Passed locally and in Docker                               |
| Production Docker image build | Passed, explicit `production` target                       |
| Formatting                    | Passed                                                     |
| Compose configuration         | Passed for default and development configurations          |

Inspection confirmed both application containers use the same image ID. The
production runtime is Node.js 24.21.0 and runs as `node` (UID 1000). PostgreSQL
and Redis report healthy. Expected "No jobs found" warnings remain because
M0 intentionally defines no job classes.

Commands executed from the application directory included:

```sh
cp .env.example .env
npm run format
npm run lint
npm run typecheck
npm run format:check
npm run build
docker compose config --quiet
docker compose -f compose.yaml -f compose.dev.yaml config --quiet
docker compose up --build -d
docker compose ps -a
docker compose logs --tail 40 api worker
docker compose exec -T postgres psql -U platform -d data_integration -c 'SELECT 1 AS connected'
docker compose exec -T redis redis-cli ping
docker build --target production -t data-integration-platform:production .
docker build --target development -t data-integration-platform:development .
docker compose -f compose.yaml -f compose.dev.yaml run --rm --no-deps api npm test
docker inspect data-integration-platform-api-1 data-integration-platform-worker-1 --format '{{.Name}} image={{.Image}} running={{.State.Running}}'
docker compose exec -T api node --version
docker compose exec -T api id
```

The copy command used PowerShell's `Copy-Item`. Local Japa was run with
`$env:PORT='3334'; npm test` to avoid the running container's HTTP port. HTTP
checks used Node.js `fetch` inside the API container.

## Environment-specific issue

Docker Desktop was initially stopped; it was started for validation. Windows
rejected binding localhost port 5432. This machine's ignored `.env` uses
`DB_PORT=55432`; the example retains the conventional default 5432. The internal
database port remains 5432. No unresolved M0 implementation issues remain.
Public example credentials are intended only for local development.

No M1 work, domain models, migrations, integrations, reconciliation logic,
authentication, frontend, or CI workflows were implemented.
