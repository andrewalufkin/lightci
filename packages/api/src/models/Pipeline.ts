import { Step } from './Step';

export interface PipelineConfig {
  name: string;
  repository: string;
  description?: string;
  defaultBranch?: string;
  steps: Omit<Step, 'id' | 'status' | 'duration' | 'error'>[];
  triggers?: {
    events?: ('push' | 'pull_request')[];
    branches?: string[];
  };
  schedule?: Record<string, any>;
  
  // GitHub configuration
  githubToken?: string;
  
  // Artifact configuration
  artifactsEnabled?: boolean;
  artifactPatterns?: string[];
  artifactRetentionDays?: number;
  artifactStorageType?: string;
  artifactStorageConfig?: Record<string, any>;
  
  // Deployment configuration
  deploymentEnabled?: boolean;
  deploymentPlatform?: string;
  deploymentConfig?: Record<string, any>;
}

export interface Pipeline {
  id: string;
  name: string;
  repository: string;
  workspaceId: string;
  description?: string;
  defaultBranch: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  steps: PipelineStep[];
  triggers?: {
    events?: ('push' | 'pull_request')[];
    branches?: string[];
  };
  schedule?: Record<string, any>;
  webhookConfig?: {
    github?: {
      id: number;
      url: string;
    };
  };
  
  // Artifact configuration
  artifactsEnabled: boolean;
  artifactPatterns: string[];
  artifactRetentionDays: number;
  artifactStorageType: string;
  artifactStorageConfig: Record<string, any>;
  artifactConfig?: {
    patterns?: string[];
    retentionDays?: number;
    enabled?: boolean;
  };
  
  // Deployment configuration
  deploymentEnabled: boolean;
  deploymentPlatform?: string;
  deploymentConfig?: Record<string, any>;
  
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
}

export interface PipelineStep {
  id?: string;
  name: string;
  command: string;
  timeout?: number;
  environment?: Record<string, string>;
  runOnDeployedInstance?: boolean;
  runLocation?: string;
  type?: string;
  description?: string;
  automatic?: boolean;
}

export interface StepResult {
  id: string;
  name: string;
  command: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  environment: Record<string, string>;
  startTime?: Date;
  endTime?: Date;
  output?: string;
  error?: string;
  runLocation?: 'local' | 'deployed';
  runOnDeployedInstance?: boolean;
}

// This type is used when we need to handle raw pipeline data from the database
// where steps might be stored as a JSON string
export type PipelineWithSteps = Omit<Pipeline, 'steps'> & {
  steps: PipelineStep[] | string;
};
