/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import router from '@adonisjs/core/services/router'

router.get('/', async () => ({ name: 'data-integration-platform' }))

const IntegrationSyncsController = () => import('#controllers/integration_syncs_controller')
router.post('/integrations/:id/sync', [IntegrationSyncsController, 'store'])
