import { Router } from 'express';
import { RequestHandler } from 'express-serve-static-core';
import { WebhookController } from '../controllers/webhook.controller.js';
import { EngineService } from '../services/engine.service.js';
import { GitHubService } from '../services/github.service.js';
import { PipelineRunnerService } from '../services/pipeline-runner.service.js';
import { WorkspaceService } from '../services/workspace.service.js';
import { PipelineService } from '../services/pipeline.service.js';
import { SchedulerService } from '../services/scheduler.service.js';
import { authenticate } from '../middleware/auth.middleware.js';

const router = Router();

// Initialize services
const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3000');
const workspaceService = new WorkspaceService();
const pipelineRunner = new PipelineRunnerService(workspaceService);
const pipelineService = new PipelineService(engineService, undefined); // Pass undefined for schedulerService initially
const schedulerService = new SchedulerService(pipelineRunner, pipelineService);

// Now that schedulerService is created, set it on pipelineService
(pipelineService as any).schedulerService = schedulerService;

const webhookController = new WebhookController(
  pipelineService,
  pipelineRunner
);

// GitHub webhook endpoint
router.post('/github',
  webhookController.handleGitHubWebhook.bind(webhookController) as unknown as RequestHandler
);

// GitLab webhook endpoint
router.post('/gitlab',
  webhookController.handleGitLabWebhook.bind(webhookController) as unknown as RequestHandler
);

export { router as webhookRouter };
