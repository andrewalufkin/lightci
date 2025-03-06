import { Request } from 'express';

export interface RequestWithParams extends Request {
  params: {
    runId: string;
    [key: string]: string;
  };
} 