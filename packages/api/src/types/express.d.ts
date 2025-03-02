import { PrismaClient } from '@prisma/client';

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