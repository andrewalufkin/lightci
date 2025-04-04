import type { Request, Response, NextFunction } from 'express-serve-static-core';
import { AuthenticationError } from '../utils/errors.js';
import { prisma } from '../lib/prisma.js';
import { verifyJWT } from '../utils/auth.utils.js';

// Constants
const JWT_SECRET = process.env.JWT_SECRET || 'your-jwt-secret';

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
      console.log('No token provided or invalid format');
      res.status(401).json({ error: 'No token provided' });
      return;
    }
    
    const token = authHeader.split(' ')[1];
    
    try {
      // Verify the token using verifyJWT from auth.utils.js
      const decoded = verifyJWT(token);
      console.log('Token verified for user ID:', decoded.userId);
      
      // Get the user from the database
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
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
        console.log('User not found for ID:', decoded.userId);
        res.status(401).json({ error: 'User not found' });
        return;
      }
      
      if (user.accountStatus !== 'active') {
        console.log('Account not active for user:', user.id);
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
      
      req.userId = decoded.userId;

      next();
    } catch (error) {
      console.error('[Auth Error]', error);
      if (error instanceof Error && 
          (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError')) {
        res.status(401).json({ error: 'Invalid token' });
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  } catch (error) {
    console.error('Unexpected error in auth middleware:', error);
    next(new AuthenticationError('Authentication failed'));
  }
};