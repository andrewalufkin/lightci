import { PrismaClient } from '@prisma/client';
import { Request } from 'express';
import type { RequestHandler } from 'express-serve-static-core';

declare global {
  namespace Express {
    interface Request {
      user: {
        id: string;
        email: string;
        username?: string;
        fullName?: string;
        accountStatus: string;
        accountTier: string;
      };
    }
  }
}

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    username: string;
  };
}

export type AuthenticatedRequestHandler = RequestHandler<any, any, any, any, { user: { id: string; email: string; username: string; } }>; 