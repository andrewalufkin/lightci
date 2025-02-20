import { PrismaClient, Pipeline, Build, BuildLog, Artifact } from '@prisma/client';
import { DatabaseService as PrismaService } from '../config/database';
import { PaginationOptions, PaginatedResult } from '../models/types';
import { NotFoundError } from '../utils/errors';

export class DatabaseService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = PrismaService.getInstance().getClient();
  }

  // Pipeline operations
  async createPipeline(data: Omit<Pipeline, 'id' | 'createdAt' | 'updatedAt'>): Promise<Pipeline> {
    return this.prisma.pipeline.create({
      data: {
        name: data.name,
        repository: data.repository,
        defaultBranch: data.defaultBranch,
        workspaceId: data.workspaceId,
        status: data.status,
        description: data.description
      }
    });
  }

  async getPipeline(id: string): Promise<Pipeline | null> {
    return this.prisma.pipeline.findUnique({
      where: { id }
    });
  }

  async listPipelines(options: PaginationOptions): Promise<PaginatedResult<Pipeline>> {
    const { page, limit, filter } = options;
    const skip = (page - 1) * limit;

    const where = filter ? {
      OR: [
        { name: { contains: filter } },
        { repository: { contains: filter } }
      ]
    } : undefined;

    const [items, total] = await Promise.all([
      this.prisma.pipeline.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      this.prisma.pipeline.count({ where })
    ]);

    return {
      items,
      total,
      page,
      limit
    };
  }

  async updatePipeline(id: string, data: Partial<Pipeline>): Promise<Pipeline> {
    return this.prisma.pipeline.update({
      where: { id },
      data
    });
  }

  async deletePipeline(id: string): Promise<void> {
    await this.prisma.pipeline.delete({
      where: { id }
    });
  }

  // Build operations
  async createBuild(data: Omit<Build, 'id' | 'createdAt' | 'updatedAt'>): Promise<Build> {
    return this.prisma.build.create({
      data
    });
  }

  async getBuild(id: string): Promise<Build | null> {
    return this.prisma.build.findUnique({
      where: { id },
      include: {
        logs: true,
        artifacts: true
      }
    });
  }

  async listBuilds(options: PaginationOptions & { pipelineId?: string }): Promise<PaginatedResult<Build>> {
    const { page, limit, pipelineId } = options;
    const skip = (page - 1) * limit;

    const where = pipelineId ? { pipelineId } : undefined;

    const [items, total] = await Promise.all([
      this.prisma.build.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          logs: true,
          artifacts: true
        }
      }),
      this.prisma.build.count({ where })
    ]);

    return {
      items,
      total,
      page,
      limit
    };
  }

  async updateBuild(id: string, data: Partial<Build>): Promise<Build> {
    return this.prisma.build.update({
      where: { id },
      data,
      include: {
        logs: true,
        artifacts: true
      }
    });
  }

  // BuildLog operations
  async createBuildLog(data: Omit<BuildLog, 'id' | 'timestamp'>): Promise<BuildLog> {
    return this.prisma.buildLog.create({
      data
    });
  }

  async getBuildLogs(buildId: string): Promise<BuildLog[]> {
    return this.prisma.buildLog.findMany({
      where: { buildId },
      orderBy: { timestamp: 'asc' }
    });
  }

  // Artifact operations
  async createArtifact(data: Omit<Artifact, 'id' | 'createdAt'>): Promise<Artifact> {
    return this.prisma.artifact.create({
      data
    });
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    return this.prisma.artifact.findUnique({
      where: { id }
    });
  }

  async getBuildArtifacts(buildId: string): Promise<Artifact[]> {
    return this.prisma.artifact.findMany({
      where: { buildId }
    });
  }

  async deleteArtifact(id: string): Promise<void> {
    await this.prisma.artifact.delete({
      where: { id }
    });
  }
} 