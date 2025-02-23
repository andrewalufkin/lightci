import express from 'express';
import cors from 'cors';
import { pipelineRouter } from './routes/pipelines.js';
import { pipelineRunRouter } from './routes/pipeline-runs.js';
import { AuthenticationError, NotFoundError, ValidationError } from './utils/errors.js';
import { scheduleArtifactCleanup } from './services/artifact-cleanup.service';

const app = express();

// Initialize artifact cleanup service
scheduleArtifactCleanup();

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/pipelines', pipelineRouter);
app.use('/api/runs', pipelineRunRouter);

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
