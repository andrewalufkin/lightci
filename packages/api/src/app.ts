import express from 'express';
import type { Request, Response, ErrorRequestHandler } from 'express-serve-static-core';
import type { CorsOptions } from 'cors';
import { pipelineRouter } from './routes/pipelines';
import { pipelineRunRouter } from './routes/pipeline-runs';
import { artifactRouter } from './routes/artifacts';
import { deploymentRouter } from './routes/deployments';
import { webhookRouter } from './routes/webhooks';
import { projectRouter } from './routes/projects';
import authRouter from './routes/auth.routes';
import { AuthenticationError, NotFoundError, ValidationError } from './utils/errors';
import { scheduleArtifactCleanup } from './services/artifact-cleanup.service';
import { PipelineStateService } from './services/pipeline-state.service';
import { SchedulerService } from './services/scheduler.service';
import { PipelineRunnerService } from './services/pipeline-runner.service';
import { WorkspaceService } from './services/workspace.service';
import cors from 'cors';

const app = express();
const pipelineStateService = new PipelineStateService();
const workspaceService = new WorkspaceService();
const pipelineRunnerService = new PipelineRunnerService(workspaceService);
const schedulerService = new SchedulerService(pipelineRunnerService);

// Initialize services
scheduleArtifactCleanup();
schedulerService.initialize().catch(error => {
  console.error('Failed to initialize scheduler service:', error);
});

// Handle graceful shutdown
const cleanup = async () => {
  console.log('Received shutdown signal. Cleaning up...');
  await pipelineStateService.cleanupRunningPipelines();
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Configure middleware
const corsOptions: CorsOptions = {
  origin: true, // Allow all origins
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());

// Configure routes
app.use('/api/pipelines', pipelineRouter);
app.use('/api/pipeline-runs', pipelineRunRouter);
app.use('/api/artifacts', artifactRouter);
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

export default app;
