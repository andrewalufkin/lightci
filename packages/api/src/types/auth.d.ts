import { Request, Response } from 'express-serve-static-core';

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    username?: string;
    fullName?: string;
    accountStatus: string;
    accountTier: string;
  };
}

export type AuthenticatedRequestHandler = (req: AuthenticatedRequest, res: Response) => Promise<void>; 