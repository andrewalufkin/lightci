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
  description?: string;
  repository: string;
  defaultBranch: string;
  steps: PipelineStep[];
  triggers?: Record<string, any>;
  schedule?: Record<string, any>;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export class DatabaseService {
  transformPipelineFromDb(dbPipeline: any): DatabasePipeline {
    return {
      id: dbPipeline.id,
      name: dbPipeline.name,
      repository: dbPipeline.repository,
      description: dbPipeline.description,
      defaultBranch: dbPipeline.defaultBranch,
      steps: typeof dbPipeline.steps === 'string' ? JSON.parse(dbPipeline.steps) : dbPipeline.steps,
      triggers: typeof dbPipeline.triggers === 'string' ? JSON.parse(dbPipeline.triggers) : dbPipeline.triggers,
      schedule: typeof dbPipeline.schedule === 'string' ? JSON.parse(dbPipeline.schedule) : dbPipeline.schedule,
      status: dbPipeline.status,
      createdAt: dbPipeline.createdAt,
      updatedAt: dbPipeline.updatedAt
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
        steps: pipeline.steps,
        triggers: pipeline.triggers,
        schedule: pipeline.schedule,
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
    if (pipeline.steps) data.steps = pipeline.steps;
    if (pipeline.triggers) data.triggers = pipeline.triggers;
    if (pipeline.schedule) data.schedule = pipeline.schedule;

    const updated = await prisma.pipeline.update({
      where: { id },
      data,
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
