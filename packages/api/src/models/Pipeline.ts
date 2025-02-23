import { Step } from './Step';

export interface PipelineConfig {
  name: string;
  repository: string;
  description?: string;
  defaultBranch?: string;
  steps: Omit<Step, 'id' | 'status' | 'duration' | 'error'>[];
  artifactsEnabled?: boolean;
  artifactPatterns?: string[];
  artifactRetentionDays?: number;
  artifactStorageType?: string;
  artifactStorageConfig?: Record<string, any>;
}

export interface Pipeline {
  id: string;
  name: string;
  repository: string;
  workspaceId: string;
  description?: string;
  defaultBranch: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  steps: Step[];
  triggers?: Record<string, any>;
  schedule?: Record<string, any>;
  artifactsEnabled: boolean;
  artifactPatterns: string[];
  artifactRetentionDays: number;
  artifactStorageType: string;
  artifactStorageConfig: Record<string, any>;
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
