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

  async listPipelines(options: { page: number; limit: number; filter?: string; sort?: string; }): Promise<PaginatedResult<DatabasePipeline>> {
    const { page, limit, filter, sort } = options;

    // Build where clause for filtering
    const where = filter ? {
      OR: [
        { name: { contains: filter, mode: 'insensitive' } },
        { repository: { contains: filter, mode: 'insensitive' } },
        { description: { contains: filter, mode: 'insensitive' } }
      ]
    } : {};

    // Build orderBy clause for sorting
    let orderBy = {};
    if (sort) {
      const [field, order] = sort.split(':');
      orderBy = { [field]: order };
    }

    // Get total count for pagination
    const total = await prisma.pipeline.count({ where });

    // Get paginated results
    const items = await prisma.pipeline.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit
    });

    return {
      items: items.map(this.transformPipelineFromDb),
      total,
      page,
      limit
    };
  }

  async createPipeline(pipeline: Omit<DatabasePipeline, 'id' | 'status' | 'createdAt' | 'updatedAt'>): Promise<DatabasePipeline> {
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

  async getPipeline(id: string): Promise<DatabasePipeline | null> {
    const pipeline = await prisma.pipeline.findUnique({
      where: { id }
    });
    return pipeline ? this.transformPipelineFromDb(pipeline) : null;
  }

  async updatePipeline(id: string, pipeline: Partial<Omit<DatabasePipeline, 'id' | 'createdAt' | 'updatedAt'>>): Promise<DatabasePipeline> {
    const data: any = {};

    if (pipeline.name) data.name = pipeline.name;
    if (pipeline.description !== undefined) data.description = pipeline.description;
    if (pipeline.repository) data.repository = pipeline.repository;
    if (pipeline.defaultBranch) data.defaultBranch = pipeline.defaultBranch;
    if (pipeline.status) data.status = pipeline.status;
    if (pipeline.steps) data.steps = JSON.stringify(pipeline.steps);
    if (pipeline.triggers) data.triggers = JSON.stringify(pipeline.triggers);
    if (pipeline.schedule) data.schedule = JSON.stringify(pipeline.schedule);
    
    // Artifact configuration
    if (pipeline.artifactsEnabled !== undefined) data.artifactsEnabled = pipeline.artifactsEnabled;
    if (pipeline.artifactPatterns) data.artifactPatterns = JSON.stringify(pipeline.artifactPatterns);
    if (pipeline.artifactRetentionDays !== undefined) data.artifactRetentionDays = pipeline.artifactRetentionDays;
    if (pipeline.artifactStorageType) data.artifactStorageType = pipeline.artifactStorageType;
    if (pipeline.artifactStorageConfig) data.artifactStorageConfig = JSON.stringify(pipeline.artifactStorageConfig);
    
    // Deployment configuration
    if (pipeline.deploymentEnabled !== undefined) data.deploymentEnabled = pipeline.deploymentEnabled;
    if (pipeline.deploymentPlatform !== undefined) data.deploymentPlatform = pipeline.deploymentPlatform;
    if (pipeline.deploymentConfig) data.deploymentConfig = JSON.stringify(pipeline.deploymentConfig);

    const updated = await prisma.pipeline.update({
      where: { id },
      data,
    });
    return this.transformPipelineFromDb(updated);
  }

  async deletePipeline(id: string): Promise<void> {
    try {
      // First check if pipeline exists
      const pipeline = await prisma.pipeline.findUnique({
        where: { id }
      });

      if (!pipeline) {
        console.log(`[Database] Pipeline ${id} not found, skipping deletion`);
        return;
      }

      // Delete all pipeline runs first
      const deleteRunsResult = await prisma.pipelineRun.deleteMany({
        where: { 
          OR: [
            { pipelineId: id },
            { pipeline: { id } }
          ]
        }
      });
      console.log(`[Database] Deleted ${deleteRunsResult.count} pipeline runs for pipeline ${id}`);

      // Then delete the pipeline itself
      await prisma.pipeline.delete({
        where: { id }
      });

      console.log(`[Database] Successfully deleted pipeline ${id} and its runs from database`);
    } catch (error) {
      console.error(`[Database] Error deleting pipeline ${id}:`, error);
      if (error instanceof Error && error.name === 'PrismaClientKnownRequestError') {
        // If pipeline doesn't exist, just log and return
        if ((error as any).code === 'P2025') {
          console.log(`[Database] Pipeline ${id} already deleted, skipping`);
          return;
        }
      }
      throw error;
    }
  }
}

export const db = new DatabaseService();
