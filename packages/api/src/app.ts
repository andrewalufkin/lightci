import express from 'express';
import cors from 'cors';
import { pipelineRouter } from './routes/pipelines.js';
import { pipelineRunRouter } from './routes/pipeline-runs.js';
import { artifactRouter } from './routes/artifacts.js';
import { deploymentRouter } from './routes/deployments';
import { webhookRouter } from './routes/webhooks';
import authRouter from './routes/auth.routes';
import { AuthenticationError, NotFoundError, ValidationError } from './utils/errors.js';
import { scheduleArtifactCleanup } from './services/artifact-cleanup.service';
import { PipelineStateService } from './services/pipeline-state.service';

const app = express();
const pipelineStateService = new PipelineStateService();

// Initialize services
scheduleArtifactCleanup();
pipelineStateService.recoverStuckPipelines();

// Handle graceful shutdown
const cleanup = async () => {
  console.log('Received shutdown signal. Cleaning up...');
  await pipelineStateService.cleanupRunningPipelines();
  process.exit(0);
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/auth', authRouter);
app.use('/api/pipelines', pipelineRouter);
app.use('/api/pipeline-runs', pipelineRunRouter);
app.use('/api/artifacts', artifactRouter);
app.use('/api/deployments', deploymentRouter);
app.use('/api/webhooks', webhookRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err);
  
  if (err instanceof AuthenticationError) {
    res.status(401).json({ error: err.message });
  } else if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
  } else if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
  } else {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default app;
