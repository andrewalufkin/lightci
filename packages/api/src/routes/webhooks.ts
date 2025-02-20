import { Router } from 'express';
import { WebhookController } from '../controllers/webhook.controller';
import { EngineService } from '../services/engine.service';

const router = Router();
const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'localhost:50051');
const webhookController = new WebhookController(engineService);

// GitHub webhook endpoint
router.post('/github',
  webhookController.handleGitHubWebhook.bind(webhookController)
);

// GitLab webhook endpoint
router.post('/gitlab',
  webhookController.handleGitLabWebhook.bind(webhookController)
);

export { router as webhookRouter };
