import express from 'express';
import cors from 'cors';
import { pipelineRouter } from './routes/pipelines.js';
import { buildRouter } from './routes/builds.js';
import { artifactRouter } from './routes/artifacts.js';
import { webhookRouter } from './routes/webhooks.js';
import { AuthenticationError, NotFoundError, ValidationError } from './utils/errors.js';
import { DatabaseService } from './config/database.js';

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// CORS configuration
const corsOptions = {
  origin: ['http://localhost:5173'], // Vite's default port
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'x-api-key'],
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  const oldSend = res.send;
  res.send = function (data) {
    console.log(`[${new Date().toISOString()}] Response status: ${res.statusCode}`);
    if (res.statusCode >= 400) {
      console.error('Response error:', data);
    }
    return oldSend.apply(res, arguments);
  };
  next();
});

// API routes
app.use('/api/pipelines', pipelineRouter);
app.use('/api/builds', buildRouter);
app.use('/api/artifacts', artifactRouter);
app.use('/api/webhooks', webhookRouter);

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const dbService = DatabaseService.getInstance();
    const isDbHealthy = await dbService.healthCheck();

    if (!isDbHealthy) {
      return res.status(503).json({
        status: 'error',
        message: 'Database connection failed'
      });
    }

    res.json({
      status: 'ok',
      version: process.env.npm_package_version,
      environment: process.env.NODE_ENV
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      message: 'Health check failed'
    });
  }
});

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
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

// 404 handler for unmatched routes
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested resource was not found'
  });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

export default app;
