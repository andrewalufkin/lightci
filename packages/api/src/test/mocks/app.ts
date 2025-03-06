import express from 'express';
import type { Request, Response } from 'express-serve-static-core';
import type { ErrorRequestHandler } from 'express-serve-static-core';
import authRoutes from '../../routes/auth.routes';
import { AuthenticationError, ValidationError, AuthorizationError } from '../../utils/errors';

const app = express();

// Configure middleware
app.use(express.json());

// Configure routes
app.use('/api/auth', authRoutes);

// Error handling middleware
const errorHandler: ErrorRequestHandler = (err: any, req: Request, res: Response) => {
  console.log('Error handler received error:', {
    name: err?.name,
    message: err?.message,
    constructor: err?.constructor?.name,
    instanceof: {
      Error: err instanceof Error,
      ValidationError: err instanceof ValidationError,
      AuthenticationError: err instanceof AuthenticationError,
      AuthorizationError: err instanceof AuthorizationError
    }
  });

  // Handle errors based on their name
  switch (err?.name) {
    case 'ValidationError':
      console.log('Handling ValidationError');
      res.status(400).json({ error: err.message });
      break;
    
    case 'AuthenticationError':
      console.log('Handling AuthenticationError');
      res.status(401).json({ error: err.message });
      break;

    case 'AuthorizationError':
      console.log('Handling AuthorizationError');
      res.status(403).json({ error: err.message });
      break;

    default:
      console.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
  }
};

app.use(errorHandler);

export default app; 