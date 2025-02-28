import { Request, Response, NextFunction } from 'express';
import { extractBearerToken, extractAPIKey, verifyJWT, verifyAPIKey } from '../utils/auth.utils';
import { prisma } from '../lib/prisma';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    username?: string;
  };
}

export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  // Try JWT authentication first
  const token = extractBearerToken(authHeader);
  if (token) {
    try {
      const payload = verifyJWT(token);
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: {
          id: true,
          email: true,
          username: true,
          accountStatus: true,
        },
      });

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      if (user.accountStatus !== 'active') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      req.user = {
        id: user.id,
        email: user.email,
        username: user.username || undefined,
      };

      return next();
    } catch (error) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  // Try API key authentication
  const apiKey = extractAPIKey(authHeader);
  if (apiKey) {
    try {
      const storedApiKey = await prisma.apiKey.findFirst({
        where: {
          keyPrefix: apiKey.prefix,
          isActive: true,
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              accountStatus: true,
            },
          },
        },
      });

      if (!storedApiKey || !storedApiKey.user) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      const isValid = verifyAPIKey(apiKey.prefix, apiKey.secret, storedApiKey.keyHash);
      if (!isValid) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      if (storedApiKey.user.accountStatus !== 'active') {
        return res.status(403).json({ error: 'Account is not active' });
      }

      if (storedApiKey.expiresAt && storedApiKey.expiresAt < new Date()) {
        return res.status(401).json({ error: 'API key has expired' });
      }

      // Update last used timestamp
      await prisma.apiKey.update({
        where: { id: storedApiKey.id },
        data: { lastUsedAt: new Date() },
      });

      req.user = {
        id: storedApiKey.user.id,
        email: storedApiKey.user.email,
        username: storedApiKey.user.username || undefined,
      };

      return next();
    } catch (error) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
  }

  return res.status(401).json({ error: 'Authentication required' });
}

export function requireRole(roles: string[]) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const memberships = await prisma.organizationMember.findMany({
        where: {
          userId: req.user.id,
          role: {
            in: roles,
          },
        },
      });

      if (memberships.length === 0) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      next();
    } catch (error) {
      return res.status(500).json({ error: 'Error checking permissions' });
    }
  };
} 