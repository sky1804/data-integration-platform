import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

const isTest = env.get('NODE_ENV') === 'test'
const database = isTest
  ? env.get('DB_TEST_DATABASE', 'data_integration_test')
  : env.get('DB_DATABASE')

// Fail before opening a connection or running destructive test cleanup.
if (isTest && (!database.endsWith('_test') || database === env.get('DB_DATABASE'))) {
  throw new Error('DB_TEST_DATABASE must end in _test and differ from DB_DATABASE')
}

const dbConfig = defineConfig({
  connection: 'postgres',
  connections: {
    postgres: {
      client: 'pg',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD'),
        database,
      },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
    },
  },
})

export default dbConfig
