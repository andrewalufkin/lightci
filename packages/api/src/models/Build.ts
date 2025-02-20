import { Step } from './Step';

export interface Build {
  id: string;
  pipelineId: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  branch: string;
  commit: string;
  steps: Step[];
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
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
