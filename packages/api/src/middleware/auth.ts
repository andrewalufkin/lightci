import { Request, Response, NextFunction } from 'express';
import { AuthenticationError } from '../utils/errors';

const TEST_API_KEY = 'test-api-key';

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || typeof apiKey !== 'string') {
    throw new AuthenticationError('API key is required');
  }

  // In test environment, accept the test API key
  if (process.env.NODE_ENV === 'test' && apiKey === TEST_API_KEY) {
    return next();
  }

  // In production, validate against environment variable
  if (apiKey !== process.env.API_KEY) {
    throw new AuthenticationError('Invalid API key');
  }

  next();
};
