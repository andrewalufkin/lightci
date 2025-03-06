import type { Request, Response, NextFunction } from 'express-serve-static-core';
import { AuthenticationError } from '../utils/errors';
import { testDb } from '../test/utils/testDb';
import { verifyJWT } from '../utils/auth.utils';
import { authConfig } from '../config/auth.config';

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    username?: string;
    fullName?: string;
    accountStatus: string;
    accountTier: string;
  };
  headers: {
    authorization?: string;
  } & Request['headers'];
}

export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    
    const token = authHeader.split(' ')[1];

    try {
      // Verify the JWT token
      const payload = await verifyJWT(token);
      
      // Get the user from the database
      const user = await testDb.user.findUnique({
        where: { id: payload.id },
        select: {
          id: true,
          email: true,
          username: true,
          accountStatus: true,
          accountTier: true,
          fullName: true
        }
      });

      if (!user) {
        res.status(401).json({ error: 'User not found' });
        return;
      }
      
      if (user.accountStatus !== 'active') {
        res.status(401).json({ error: 'Account is not active' });
        return;
      }
      
      // Set the user on the request object with proper typing
      (req as AuthenticatedRequest).user = {
        id: user.id,
        email: user.email,
        username: user.username || undefined,
        accountStatus: user.accountStatus,
        accountTier: user.accountTier || 'free',
        fullName: user.fullName || undefined
      };
      
      next();
    } catch (error) {
      console.error('[Auth Error]', error);
      if (error instanceof Error && (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError')) {
        res.status(401).json({ error: 'Invalid token' });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  } catch (error) {
    next(new AuthenticationError('Authentication failed'));
  }
};