import { PrismaClient } from '@prisma/client';
import { PaginatedResult } from '../models/types';
import { Step } from '../models/Step';

const prisma = new PrismaClient();

export interface PipelineStep {
  id: string;
  name: string;
  command: string;
  timeout?: number;
  environment?: Record<string, string>;
}

export interface DatabasePipeline {
  id: string;
  name: string;
  repository: string;
  description?: string;
  defaultBranch: string;
  steps: any;
  triggers?: any;
  schedule?: any;
  webhookConfig?: any;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  artifactsEnabled: boolean;
  artifactPatterns?: any;
  artifactRetentionDays: number;
  artifactStorageType: string;
  artifactStorageConfig?: any;
  deploymentEnabled: boolean;
  deploymentPlatform?: string;
  deploymentConfig?: any;
}

export class DatabaseService {
  transformPipelineFromDb(dbPipeline: any): DatabasePipeline {
    return {
      id: dbPipeline.id,
      name: dbPipeline.name,
      repository: dbPipeline.repository,
      description: dbPipeline.description,
      defaultBranch: dbPipeline.defaultBranch,
      steps: dbPipeline.steps,
      triggers: dbPipeline.triggers,
      schedule: dbPipeline.schedule,
      webhookConfig: dbPipeline.webhookConfig,
      status: dbPipeline.status,
      createdAt: dbPipeline.createdAt,
      updatedAt: dbPipeline.updatedAt,
      artifactsEnabled: dbPipeline.artifactsEnabled,
      artifactPatterns: dbPipeline.artifactPatterns,
      artifactRetentionDays: dbPipeline.artifactRetentionDays,
      artifactStorageType: dbPipeline.artifactStorageType,
      artifactStorageConfig: dbPipeline.artifactStorageConfig,
      deploymentEnabled: dbPipeline.deploymentEnabled,
      deploymentPlatform: dbPipeline.deploymentPlatform,
      deploymentConfig: dbPipeline.deploymentConfig
    };
  }

  async listPipelines(options: { page: number; limit: number; filter?: string; sort?: string; where?: any; }): Promise<PaginatedResult<DatabasePipeline>> {
    const skip = (options.page - 1) * options.limit;
    const where = {
      ...options.where,
      ...(options.filter ? {
        OR: [
          { name: { contains: options.filter, mode: 'insensitive' } },
          { description: { contains: options.filter, mode: 'insensitive' } },
          { repository: { contains: options.filter, mode: 'insensitive' } }
        ]
      } : {})
    };

    const [total, items] = await Promise.all([
      prisma.pipeline.count({ where }),
      prisma.pipeline.findMany({
        where,
        skip,
        take: options.limit,
        orderBy: { createdAt: 'desc' }
      })
    ]);

    return {
      items: items.map(p => this.transformPipelineFromDb(p)),
      total,
      page: options.page,
      limit: options.limit,
      totalPages: Math.ceil(total / options.limit)
    };
  }

  async getPipeline(id: string, userId: string): Promise<DatabasePipeline | null> {
    const pipeline = await prisma.pipeline.findFirst({
      where: {
        id,
        createdById: userId
      }
    });
    if (!pipeline) return null;
    return this.transformPipelineFromDb(pipeline);
  }

  async createPipeline(pipeline: Omit<DatabasePipeline, 'id' | 'status' | 'createdAt' | 'updatedAt'> & { createdById: string }): Promise<DatabasePipeline> {
    const created = await prisma.pipeline.create({
      data: {
        name: pipeline.name,
        repository: pipeline.repository,
        description: pipeline.description,
        defaultBranch: pipeline.defaultBranch,
        steps: JSON.stringify(pipeline.steps),
        triggers: pipeline.triggers ? JSON.stringify(pipeline.triggers) : undefined,
        schedule: pipeline.schedule ? JSON.stringify(pipeline.schedule) : undefined,
        webhookConfig: pipeline.webhookConfig ? JSON.stringify(pipeline.webhookConfig) : undefined,
        createdById: pipeline.createdById,
        
        // Artifact configuration
        artifactsEnabled: pipeline.artifactsEnabled ?? true,
        artifactPatterns: JSON.stringify(pipeline.artifactPatterns ?? []),
        artifactRetentionDays: pipeline.artifactRetentionDays ?? 30,
        artifactStorageType: pipeline.artifactStorageType ?? 'local',
        artifactStorageConfig: JSON.stringify(pipeline.artifactStorageConfig ?? {}),
        
        // Deployment configuration
        deploymentEnabled: pipeline.deploymentEnabled ?? false,
        deploymentPlatform: pipeline.deploymentPlatform,
        deploymentConfig: pipeline.deploymentConfig ? JSON.stringify(pipeline.deploymentConfig) : JSON.stringify({}),
        
        status: 'created'
      }
    });
    return this.transformPipelineFromDb(created);
  }

  async updatePipeline(id: string, pipeline: Partial<Omit<DatabasePipeline, 'id' | 'createdAt' | 'updatedAt'>>): Promise<DatabasePipeline> {
    const updated = await prisma.pipeline.update({
      where: { id },
      data: {
        ...(pipeline.name && { name: pipeline.name }),
        ...(pipeline.repository && { repository: pipeline.repository }),
        ...(pipeline.description !== undefined && { description: pipeline.description }),
        ...(pipeline.defaultBranch && { defaultBranch: pipeline.defaultBranch }),
        ...(pipeline.steps && { steps: JSON.stringify(pipeline.steps) }),
        ...(pipeline.triggers && { triggers: JSON.stringify(pipeline.triggers) }),
        ...(pipeline.schedule && { schedule: JSON.stringify(pipeline.schedule) }),
        ...(pipeline.webhookConfig && { webhookConfig: JSON.stringify(pipeline.webhookConfig) }),
        
        // Artifact configuration
        ...(pipeline.artifactsEnabled !== undefined && { artifactsEnabled: pipeline.artifactsEnabled }),
        ...(pipeline.artifactPatterns && { artifactPatterns: JSON.stringify(pipeline.artifactPatterns) }),
        ...(pipeline.artifactRetentionDays && { artifactRetentionDays: pipeline.artifactRetentionDays }),
        ...(pipeline.artifactStorageType && { artifactStorageType: pipeline.artifactStorageType }),
        ...(pipeline.artifactStorageConfig && { artifactStorageConfig: JSON.stringify(pipeline.artifactStorageConfig) }),
        
        // Deployment configuration
        ...(pipeline.deploymentEnabled !== undefined && { deploymentEnabled: pipeline.deploymentEnabled }),
        ...(pipeline.deploymentPlatform !== undefined && { deploymentPlatform: pipeline.deploymentPlatform }),
        ...(pipeline.deploymentConfig && { deploymentConfig: JSON.stringify(pipeline.deploymentConfig) })
      }
    });
    return this.transformPipelineFromDb(updated);
  }

  async deletePipeline(id: string): Promise<void> {
    await prisma.pipeline.delete({
      where: { id }
    });
  }
}

export const db = new DatabaseService();
