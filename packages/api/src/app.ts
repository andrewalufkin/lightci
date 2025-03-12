import express from 'express';
import type { Request, Response, ErrorRequestHandler } from 'express-serve-static-core';
import type { CorsOptions } from 'cors';
import cors from 'cors';
import { pipelineRouter } from './routes/pipelines.js';
import { pipelineRunRouter } from './routes/pipeline-runs.js';
import { createArtifactRouter } from './routes/artifacts.js';
import { deploymentRouter } from './routes/deployments.js';
import { webhookRouter } from './routes/webhooks.js';
import { projectRouter } from './routes/projects.js';
import authRouter from './routes/auth.routes.js';
import userRouter from './routes/user.js';
import billingRouter from './routes/billing.js';
import stripeRouter from './routes/stripe.js';
import { AuthenticationError, NotFoundError, ValidationError } from './utils/errors.js';
import { scheduleArtifactCleanup, stopArtifactCleanup } from './services/artifact-cleanup.service.js';
import { PipelineStateService } from './services/pipeline-state.service.js';
import { SchedulerService } from './services/scheduler.service.js';
import { PipelineRunnerService } from './services/pipeline-runner.service.js';
import { WorkspaceService } from './services/workspace.service.js';
import { EngineService } from './services/engine.service.js';

const app = express();
const pipelineStateService = new PipelineStateService();

// Store service instances for cleanup
let workspaceService: WorkspaceService;
let pipelineRunnerService: PipelineRunnerService;
let schedulerService: SchedulerService;
let engineService: EngineService;

// Configure middleware
const corsOptions: CorsOptions = {
  origin: true, // Allow all origins
  credentials: true
};

// Initialize services and middleware
const initializeApp = async () => {
  app.use(cors(corsOptions));
  app.use(express.json());
  
  workspaceService = new WorkspaceService();
  pipelineRunnerService = new PipelineRunnerService(workspaceService);
  schedulerService = new SchedulerService(pipelineRunnerService);
  engineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3001');

  // Skip service initialization in test mode to prevent hanging
  if (process.env.NODE_ENV !== 'test') {
    // Initialize services
    scheduleArtifactCleanup();
    schedulerService.initialize().catch(error => {
      console.error('Failed to initialize scheduler service:', error);
    });
    pipelineStateService.startMonitoring();
  }

  // Configure routes
  app.use('/api/pipelines', pipelineRouter);
  app.use('/api/pipeline-runs', pipelineRunRouter);
  app.use('/api/artifacts', createArtifactRouter(engineService));
  app.use('/api/deployments', deploymentRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use('/api/projects', projectRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/user', userRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/stripe', stripeRouter);
};

// Handle graceful shutdown
const cleanup = async () => {
  console.log('Received shutdown signal. Cleaning up...');
  
  // Stop the scheduler
  if (schedulerService) {
    schedulerService.stopAll();
  }
  
  // Clean up pipeline runner
  if (pipelineRunnerService) {
    await pipelineRunnerService.cleanup();
  }
  
  // Clean up running pipelines and stop monitoring
  pipelineStateService.stopMonitoring();
  await pipelineStateService.cleanupRunningPipelines();
  
  // Stop artifact cleanup
  stopArtifactCleanup();
  
  // In non-test environments, exit the process
  if (process.env.NODE_ENV !== 'test') {
    process.exit(0);
  }
};

// Export cleanup function for tests
export const cleanupForTests = cleanup;

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

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

// Initialize the app and export it
const appPromise = (async () => {
  await initializeApp().catch(error => {
    console.error('Failed to initialize app:', error);
    process.exit(1);
  });
  return app;
})();

export default appPromise;
