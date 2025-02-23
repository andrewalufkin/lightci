import { Step } from './Step';

export interface Build {
  id: string;
  pipelineId: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  branch: string;
  commit: string;
  steps?: Step[];
  stepResults?: {
    id: string;
    name: string;
    status: string;
    command: string;
    output?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
  }[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  queuePosition?: number;
  triggeredBy?: string;
  parameters?: Record<string, string>;
}

export interface BuildConfig {
  branch?: string;
  commit?: string;
  parameters?: Record<string, string>;
}
