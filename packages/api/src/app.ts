import express from 'express';
import cors from 'cors';
import { Request, Response, NextFunction } from 'express';
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
app.use(cors());
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
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);

  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
  } else if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
  } else if (err instanceof AuthenticationError) {
    res.status(401).json({ error: err.message });
  } else {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default app;
