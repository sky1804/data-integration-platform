// Optional Docker end-to-end validation. Requires the built production image
// and healthy Compose postgres/redis/carrier-mock services. No development writes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('../../', import.meta.url))
const docker = (...args) =>
  execFileSync('docker', args, { cwd, encoding: 'utf8', timeout: 30000 }).trim()
const config = JSON.parse(docker('compose', 'config', '--format', 'json'))
const dbUser = config.services.postgres.environment.POSTGRES_USER
const stamp = Date.now()
const database = `m4_validation_${stamp}_test`
const prefix = `m4-validation-${stamp}`
const containers = []
let ownsDatabase = false
let validationApi
let passed = false

function start(...args) {
  const id = docker(...args)
    .split(/\r?\n/)
    .at(-1)
  assert.match(id, /^[a-f\d]{64}$/)
  containers.push(id)
  return id
}

function sql(databaseName, statement) {
  return docker(
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    dbUser,
    '-d',
    databaseName,
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    statement
  )
}

function devCounts() {
  return sql(
    config.services.postgres.environment.POSTGRES_DB,
    'SELECT (SELECT count(*) FROM integrations), (SELECT count(*) FROM sync_runs), (SELECT count(*) FROM source_records)'
  )
}

async function waitFor(label, read, ready) {
  const deadline = Date.now() + 25000
  do {
    const result = await read()
    if (ready(result)) return result
    await setTimeout(200)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${label}`)
}

const boot = `
import 'reflect-metadata'
import { Ignitor } from '@adonisjs/core'
const root = new URL('file:///app/')
const importer = path => path.startsWith('./') || path.startsWith('../') ? import(new URL(path, root).href) : import(path)
const app = new Ignitor(root, { importer }).createApp('console')
app.booting(async () => { await import('#start/env') })
await app.init()
await app.boot()
await app.start(async () => {})
`

function inspect(api, jobId) {
  const result = execFileSync(
    'docker',
    ['exec', '-i', '-e', `M4_JOB_ID=${jobId}`, api, 'node', '--input-type=module', '-'],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      input: `${boot}
try {
  const { default: queue } = await import('@adonisjs/queue/services/main')
  const { default: SyncRun } = await import('#models/sync_run')
  const { default: SourceRecord } = await import('#models/source_record')
  const job = await queue.use().getJob(process.env.M4_JOB_ID, 'default')
  const runs = await SyncRun.query().orderBy('id')
  console.log(JSON.stringify({ job, runs: runs.map(run => ({ status: run.status, code: run.errorCode, persisted: run.recordsPersisted })), records: (await SourceRecord.all()).length }))
} finally { await app.terminate() }
`,
    }
  )
  return JSON.parse(result.trim().split(/\r?\n/).at(-1))
}

const before = devCounts()
try {
  const postgres = docker('compose', 'ps', '-q', 'postgres')
  const network = Object.keys(
    JSON.parse(docker('inspect', postgres))[0].NetworkSettings.Networks
  )[0]
  const isolatedRedis = start(
    'run',
    '-d',
    '--name',
    `${prefix}-redis`,
    '--network',
    network,
    config.services.redis.image
  )
  await waitFor(
    'isolated Redis',
    () => docker('exec', isolatedRedis, 'redis-cli', 'ping'),
    (value) => value === 'PONG'
  )
  docker('compose', 'exec', '-T', 'postgres', 'createdb', '-U', dbUser, database)
  ownsDatabase = true

  const environment = [
    '-e',
    'NODE_ENV=test',
    '-e',
    `DB_TEST_DATABASE=${database}`,
    '-e',
    `REDIS_HOST=${prefix}-redis`,
  ]
  docker(
    'compose',
    'run',
    '--rm',
    '--no-deps',
    ...environment,
    'api',
    'node',
    'ace.js',
    'migration:run',
    '--force',
    '--no-schema-generate'
  )
  const integrationId = Number(
    sql(
      database,
      "INSERT INTO integrations (name, slug, provider, enabled, created_at, updated_at) VALUES ('M4 validation', 'm4-validation', 'carrier', true, now(), now()) RETURNING id"
    ).split(/\r?\n/)[0]
  )
  assert.ok(integrationId > 0)

  // Let Docker allocate a free localhost port; the app still listens on 3333.
  const api = start(
    'compose',
    'run',
    '-d',
    '--no-deps',
    '--name',
    `${prefix}-api`,
    '-p',
    '127.0.0.1::3333',
    ...environment,
    'api',
    'node',
    'bin/server.js'
  )
  validationApi = api
  const address = docker('port', api, '3333/tcp').split(/\r?\n/)[0]
  assert.match(address, /^127\.0\.0\.1:\d+$/)
  const base = `http://${address}`
  await waitFor(
    'validation API',
    async () => {
      try {
        return (await fetch(base, { signal: AbortSignal.timeout(1000) })).status
      } catch {
        return 0
      }
    },
    (status) => status === 200
  )

  async function dispatch() {
    const response = await fetch(`${base}/integrations/${integrationId}/sync`, {
      method: 'POST',
      headers: { Connection: 'close' },
      // Redis's existing bounded reconnect policy can take longer than a short
      // HTTP client timeout after Docker DNS loses the stopped Redis container.
      signal: AbortSignal.timeout(60000),
    })
    return { status: response.status, body: await response.json() }
  }

  // There is deliberately no test worker yet: 202 must not wait for execution.
  const accepted = await dispatch()
  assert.equal(accepted.status, 202)
  const pending = inspect(api, accepted.body.jobId)
  assert.equal(pending.job.status, 'pending')
  assert.deepEqual(pending.job.data.payload, { integrationId })
  assert.equal(pending.runs.length, 0)
  assert.equal(pending.records, 0)
  console.log('HTTP 202 → real Redis pending job; no SyncRun before worker: passed')

  const worker = start(
    'compose',
    'run',
    '-d',
    '--no-deps',
    '--name',
    `${prefix}-worker`,
    ...environment,
    'worker',
    'node',
    'ace.js',
    'queue:work'
  )
  const success = await waitFor(
    'completed queue job',
    () => inspect(api, accepted.body.jobId),
    (value) => value.job?.status === 'completed'
  )
  assert.deepEqual(success.runs, [{ status: 'SUCCESS', code: null, persisted: 3 }])
  assert.equal(success.records, 3)
  assert.equal(success.job.data.attempts, 0)
  console.log('Redis → separate worker → SyncEngine → Carrier → SUCCESS and 3 records: passed')
  docker('stop', worker)

  const acceptedFailure = await dispatch()
  assert.equal(acceptedFailure.status, 202)
  assert.equal(inspect(api, acceptedFailure.body.jobId).job.status, 'pending')
  // Only the disposable worker has invalid provider credentials.
  const failedWorker = start(
    'compose',
    'run',
    '-d',
    '--no-deps',
    '--name',
    `${prefix}-failure-worker`,
    ...environment,
    '-e',
    'CARRIER_API_TOKEN=m4-invalid-token',
    'worker',
    'node',
    'ace.js',
    'queue:work'
  )
  const failure = await waitFor(
    'failed queue job',
    () => inspect(api, acceptedFailure.body.jobId),
    (value) => value.job?.status === 'failed'
  )
  assert.equal(failure.runs.length, 2)
  assert.deepEqual(failure.runs[1], {
    status: 'FAILED',
    code: 'PROVIDER_AUTHENTICATION',
    persisted: 0,
  })
  assert.equal(failure.records, 3)
  assert.equal(failure.job.data.attempts, 0)
  assert.ok(failure.job.error)
  console.log('HTTP stays 202; queue job failed; FAILED audit retained; zero retries: passed')
  docker('stop', failedWorker)

  docker('stop', isolatedRedis)
  const rejected = await dispatch()
  assert.equal(rejected.status, 503)
  assert.deepEqual(rejected.body, {
    error: { code: 'QUEUE_UNAVAILABLE', message: 'Synchronization could not be queued' },
  })
  assert.equal(sql(database, 'SELECT count(*) FROM sync_runs'), '2')
  assert.equal(devCounts(), before)
  console.log('Redis unavailable → HTTP 503; no new SyncRun; development counts unchanged: passed')
  passed = true
} finally {
  if (!passed && validationApi) {
    try {
      console.error(docker('logs', '--tail', '8', validationApi))
    } catch {
      /* Container may already have stopped. */
    }
  }
  // Remove only containers whose IDs were returned to this script on creation.
  for (const id of containers.toReversed()) {
    try {
      docker('rm', '-f', id)
    } catch (error) {
      console.error('Validation container cleanup failed', id, error.message)
      process.exitCode = 1
    }
  }
  if (ownsDatabase) {
    assert.match(database, /^m4_validation_\d+_test$/)
    try {
      docker('compose', 'exec', '-T', 'postgres', 'dropdb', '-U', dbUser, database)
    } catch (error) {
      console.error('Validation database cleanup failed', database, error.message)
      process.exitCode = 1
    }
  }
}
