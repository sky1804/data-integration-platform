import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import redis from '@adonisjs/redis/services/main'

test.group('M0 bootstrap', () => {
  test('serves the API as JSON', async ({ client }) => {
    const response = await client.get('/')
    response.assertStatus(200)
    response.assertBody({ name: 'data-integration-platform' })
  })

  test('connects to PostgreSQL through Lucid', async ({ assert }) => {
    const result = await db.rawQuery('SELECT 1 AS connected')
    assert.equal(result.rows[0].connected, 1)
  })

  test('connects to Redis through the configured client', async ({ assert }) => {
    assert.equal(await redis.ping(), 'PONG')
  })
})
