import { Router } from 'express';
import { RequestHandler } from 'express-serve-static-core';
import { WebhookController } from '../controllers/webhook.controller';
import { EngineService } from '../services/engine.service';
import { GitHubService } from '../services/github.service';
import { PipelineRunnerService } from '../services/pipeline-runner.service';
import { WorkspaceService } from '../services/workspace.service';
import { PipelineService } from '../services/pipeline.service';
import { SchedulerService } from '../services/scheduler.service';

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
