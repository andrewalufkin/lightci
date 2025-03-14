import { JsonValue } from '@prisma/client/runtime/library';

export interface Pipeline {
  id: string;
  status: string;
  name: string;
  description: string;
  repository: string;
  defaultBranch: string;
  steps: JsonValue;
  triggers: JsonValue;
  schedule: JsonValue;
  createdAt: Date;
  updatedAt: Date;
  artifactPatterns: JsonValue;
  artifactRetentionDays: number;
  artifactStorageConfig: JsonValue;
  artifactStorageType: string;
  artifactsEnabled: boolean;
  deploymentConfig: JsonValue;
  deploymentEnabled: boolean;
  deploymentMode: 'automatic' | 'manual';
  deploymentPlatform?: string;
  webhookConfig?: JsonValue;
  createdById: string;
  projectId?: string;
} 