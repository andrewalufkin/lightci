import { Step } from './Step';

export interface Pipeline {
  id: string;
  name: string;
  repository: string;
  workspaceId: string;
  description?: string;
  defaultBranch: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  steps: Step[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Step {
  id: string;
  name: string;
  command: string;
  timeout?: number;
  environment?: Record<string, string>;
  dependencies?: string[];
}

export interface PipelineConfig {
  name: string;
  repository: string;
  description?: string;
  defaultBranch?: string;
  steps: {
    id: string;
    name: string;
    command: string;
    timeout?: number;
    environment?: Record<string, string>;
    dependencies?: string[];
  }[];
  triggers?: {
    branches?: string[];
    events?: ('push' | 'pull_request')[];
  };
}
