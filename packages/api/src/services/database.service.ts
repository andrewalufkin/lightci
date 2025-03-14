import { PrismaClient } from '@prisma/client';
import { PaginatedResult } from '../models/types';

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
  deploymentMode: string;
  deploymentPlatform?: string;
  deploymentConfig?: any;
  createdById: string;
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
      deploymentMode: dbPipeline.deploymentMode,
      deploymentPlatform: dbPipeline.deploymentPlatform,
      deploymentConfig: dbPipeline.deploymentConfig,
      createdById: dbPipeline.createdById
    };
  }

  async listPipelines(options: { page: number; limit: number; filter?: string; sort?: string; where?: any; }): Promise<PaginatedResult<DatabasePipeline>> {
    console.log('[DatabaseService] Raw listPipelines input:', JSON.stringify(options, null, 2));
    
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
    console.log('[DatabaseService] Constructed where clause:', JSON.stringify(where, null, 2));

    const skip = (options.page - 1) * options.limit;
    const [total, items] = await Promise.all([
      prisma.pipeline.count({ where }),
      prisma.pipeline.findMany({
        where,
        skip,
        take: options.limit,
        orderBy: { createdAt: 'desc' }
      })
    ]);
    console.log('[DatabaseService] Raw query results:', JSON.stringify(items, null, 2));

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
        deploymentMode: pipeline.deploymentMode,
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
        ...(pipeline.name !== undefined && { name: pipeline.name }),
        ...(pipeline.repository !== undefined && { repository: pipeline.repository }),
        ...(pipeline.description !== undefined && { description: pipeline.description }),
        ...(pipeline.defaultBranch !== undefined && { defaultBranch: pipeline.defaultBranch }),
        ...(pipeline.steps !== undefined && { steps: JSON.stringify(pipeline.steps) }),
        ...(pipeline.triggers !== undefined && { triggers: JSON.stringify(pipeline.triggers) }),
        ...(pipeline.schedule !== undefined && { schedule: JSON.stringify(pipeline.schedule) }),
        ...(pipeline.webhookConfig !== undefined && { webhookConfig: JSON.stringify(pipeline.webhookConfig) }),
        
        // Artifact configuration
        ...(pipeline.artifactsEnabled !== undefined && { artifactsEnabled: pipeline.artifactsEnabled }),
        ...(pipeline.artifactPatterns !== undefined && { artifactPatterns: JSON.stringify(pipeline.artifactPatterns) }),
        ...(pipeline.artifactRetentionDays !== undefined && { artifactRetentionDays: pipeline.artifactRetentionDays }),
        ...(pipeline.artifactStorageType !== undefined && { artifactStorageType: pipeline.artifactStorageType }),
        ...(pipeline.artifactStorageConfig !== undefined && { artifactStorageConfig: JSON.stringify(pipeline.artifactStorageConfig) }),
        
        // Deployment configuration
        ...(pipeline.deploymentEnabled !== undefined && { deploymentEnabled: pipeline.deploymentEnabled }),
        ...(pipeline.deploymentMode !== undefined && { deploymentMode: pipeline.deploymentMode }),
        ...(pipeline.deploymentPlatform !== undefined && { deploymentPlatform: pipeline.deploymentPlatform }),
        ...(pipeline.deploymentConfig !== undefined && { deploymentConfig: JSON.stringify(pipeline.deploymentConfig) })
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
