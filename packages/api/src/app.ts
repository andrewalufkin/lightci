import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { pipelineRouter } from './routes/pipelines';
import { pipelineRunRouter } from './routes/pipeline-runs';
import { AuthenticationError, NotFoundError, ValidationError } from './utils/errors';

const app = express();

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/pipelines', pipelineRouter);
app.use('/api/runs', pipelineRunRouter);

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);

  if (err instanceof ValidationError) {
    return res.status(400).json({
      error: 'Validation Error',
      message: err.message
    });
  }

  if (err instanceof AuthenticationError) {
    return res.status(401).json({
      error: 'Authentication Error',
      message: err.message
    });
  }

  if (err instanceof NotFoundError) {
    return res.status(404).json({
      error: 'Not Found',
      message: err.message
    });
  }

  // Default error
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
  });
});

export default app;
