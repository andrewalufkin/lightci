import express from 'express';
import type { Request, Response, ErrorRequestHandler } from 'express-serve-static-core';
import type { CorsOptions } from 'cors';
import type { RequestHandler } from 'express';
import { pipelineRouter } from '../../routes/pipelines';
import { pipelineRunRouter } from '../../routes/pipeline-runs';
import { createArtifactRouter } from '../../routes/artifacts';
import { deploymentRouter } from '../../routes/deployments';
import { webhookRouter } from '../../routes/webhooks';
import { projectRouter } from '../../routes/projects';
import authRouter from '../../routes/auth.routes';
import { AuthenticationError, NotFoundError, ValidationError } from '../../utils/errors';
import { WebhookController } from '../../controllers/webhook.controller';
import { PipelineService } from '../../services/pipeline.service';
import { PipelineRunnerService } from '../../services/pipeline-runner.service';
import { WorkspaceService } from '../../services/workspace.service';
import { EngineService } from '../../services/engine.service';
import { SchedulerService } from '../../services/scheduler.service';
import { testDb } from './testDb';

/**
 * Creates a test app with configured controllers and services
 */
export default async function createTestApp() {
  const app = express();

  // Configure middleware
  const corsOptions: CorsOptions = {
    origin: true,
    credentials: true
  };
  
  // Import cors module
  const corsModule = await import('cors');
  app.use((corsModule as any).default(corsOptions));
  app.use(express.json());

  // Initialize services in the correct dependency order
  const workspaceService = new WorkspaceService();
  const pipelineRunner = new PipelineRunnerService(workspaceService, testDb);
  const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3000');
  const pipelineService = new PipelineService(engineService, undefined, testDb); // Pass undefined for schedulerService initially
  const schedulerService = new SchedulerService(pipelineRunner, pipelineService);
  
  // Now that schedulerService is created, set it on pipelineService
  (pipelineService as any).schedulerService = schedulerService;

  // Store services in the app
  app.set('EngineService', engineService);
  app.set('PipelineService', pipelineService);
  app.set('PipelineRunner', pipelineRunner);
  app.set('SchedulerService', schedulerService);

  // Initialize and store webhook controller
  const webhookController = new WebhookController(pipelineService, pipelineRunner);
  app.set('WebhookController', webhookController);

  // Make sure the webhookController is properly accessible
  const storedController = app.get('WebhookController');
  if (!storedController || typeof storedController.shouldTriggerForBranch !== 'function') {
    console.error('[TestApp] WebhookController is not properly configured');
  } else {
    console.log('[TestApp] WebhookController configured correctly');
  }

  // Configure routes
  app.use('/api/pipelines', pipelineRouter);
  app.use('/api/pipeline-runs', pipelineRunRouter);
  app.use('/api/artifacts', createArtifactRouter(engineService));
  app.use('/api/deployments', deploymentRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use('/api/projects', projectRouter);
  app.use('/api/auth', authRouter);

  // Error handling middleware
  const errorHandler = (
    err: any,
    _req: Request,
    res: Response,
    next: (err?: any) => void
  ): Response | void => {
    console.error('Error:', err);

    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    } 
    if (err instanceof NotFoundError) {
      return res.status(404).json({ error: err.message });
    } 
    if (err instanceof AuthenticationError) {
      return res.status(401).json({ error: err.message });
    }
    
    return res.status(500).json({ error: 'Internal server error' });
  };

  app.use(errorHandler as ErrorRequestHandler);

  return app;
} 