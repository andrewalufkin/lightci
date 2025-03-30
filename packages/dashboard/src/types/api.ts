export interface Pipeline {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  steps: {
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    duration?: string;
    logs?: string[];
    error?: string;
  }[];
  artifactsEnabled: boolean;
  artifactPatterns: string[];
}

export interface Build {
  id: string;
  pipelineId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  branch: string;
  commit: string;
  parameters?: Record<string, string>;
  steps: {
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    duration?: string;
    logs?: string[];
    error?: string;
  }[];
  stepResults?: Array<{
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    duration?: string;
    logs?: string[];
    error?: string;
  }>;
}

export interface BuildLog {
  timestamp: string;
  level: 'info' | 'error' | 'warn';
  message: string;
  stepName: string;
}

export interface Artifact {
  id: string;
  name: string;
  path: string;
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
  createdAt: Date;
}

export interface DeployedApp {
  id: string;
  name: string;
  url: string;
  status: 'running' | 'stopped' | 'failed';
  environment: string;
  lastDeployed: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
} 