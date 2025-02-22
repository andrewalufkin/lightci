import { db } from './database.service';
import { Pipeline, PipelineConfig } from '../models/Pipeline';
import { Step } from '../models/Step';
import { PaginatedResult } from '../models/types';
import { PrismaClient } from '@prisma/client';
import { DatabasePipeline } from './database.service';
import { EngineService } from './engine.service';

const prisma = new PrismaClient();
const engineService = new EngineService();

export class PipelineService {
  private async transformToModelPipeline(dbPipeline: DatabasePipeline): Promise<Pipeline> {
    // Get the latest run for this pipeline
    const latestRun = await prisma.pipelineRun.findFirst({
      where: { pipelineId: dbPipeline.id },
      orderBy: { startedAt: 'desc' }
    });

    // Parse the steps from the pipeline
    const steps = (typeof dbPipeline.steps === 'string' ? JSON.parse(dbPipeline.steps) : dbPipeline.steps) as Step[];

    // If we have a latest run, update the step statuses from it
    if (latestRun) {
      const latestStepResults = Array.isArray(latestRun.stepResults) 
        ? latestRun.stepResults 
        : (typeof latestRun.stepResults === 'string' 
          ? JSON.parse(latestRun.stepResults) 
          : []);

      // Track if we've encountered a failure
      let hasFailedStep = false;

      // Update each step's status from the latest run
      steps.forEach(step => {
        const latestStepResult = latestStepResults.find(sr => 
          (step.id && sr.id === step.id) || (!step.id && sr.name === step.name)
        );

        if (latestStepResult) {
          // Only set status if the step has actually started running
          if (latestStepResult.status !== 'pending') {
            step.status = latestStepResult.status;
            step.duration = latestStepResult.duration;
            step.error = latestStepResult.error;

            if (latestStepResult.status === 'failed') {
              hasFailedStep = true;
            }
          }
        } else if (hasFailedStep) {
          // Don't set any status for steps after a failure
          delete step.status;
        }
      });
    }

    return {
      id: dbPipeline.id,
      name: dbPipeline.name,
      repository: dbPipeline.repository,
      workspaceId: 'default', // TODO: Implement proper workspace handling
      description: dbPipeline.description,
      defaultBranch: dbPipeline.defaultBranch,
      status: dbPipeline.status as Pipeline['status'],
      steps: steps,
      triggers: dbPipeline.triggers,
      schedule: dbPipeline.schedule,
      createdAt: dbPipeline.createdAt,
      updatedAt: dbPipeline.updatedAt
    };
  }

  async listPipelines(options: { page: number; limit: number; filter?: string; sort?: string; }): Promise<PaginatedResult<Pipeline>> {
    const pipelines = await db.listPipelines(options);
    const transformedPipelines = await Promise.all(pipelines.items.map(p => this.transformToModelPipeline(p)));
    return {
      ...pipelines,
      items: transformedPipelines
    };
  }

  async getPipeline(id: string): Promise<Pipeline | null> {
    const pipeline = await db.getPipeline(id);
    if (!pipeline) return null;
    return this.transformToModelPipeline(pipeline);
  }

  async createPipeline(config: PipelineConfig): Promise<Pipeline> {
    const pipeline = {
      name: config.name,
      repository: config.repository,
      description: config.description,
      defaultBranch: config.defaultBranch || 'main',
      steps: config.steps.map(step => ({
        id: step.id || step.name,
        name: step.name,
        command: step.command,
        timeout: step.timeout,
        environment: step.environment || {}
      }))
    };

    const created = await db.createPipeline(pipeline);
    return this.transformToModelPipeline(created);
  }

  async updatePipeline(id: string, config: PipelineConfig): Promise<Pipeline> {
    const pipeline = {
      name: config.name,
      repository: config.repository,
      description: config.description,
      defaultBranch: config.defaultBranch,
      steps: config.steps.map(step => ({
        id: step.id || step.name,
        name: step.name,
        command: step.command,
        timeout: step.timeout,
        environment: step.environment || {}
      }))
    };

    const updated = await db.updatePipeline(id, pipeline);
    return this.transformToModelPipeline(updated);
  }

  async deletePipeline(id: string): Promise<void> {
    try {
      // First, get the pipeline to ensure it exists
      const pipeline = await prisma.pipeline.findUnique({
        where: { id }
      });

      if (!pipeline) {
        throw new Error('Pipeline not found');
      }

      // Delete all associated pipeline runs first
      await prisma.pipelineRun.deleteMany({
        where: { pipelineId: id }
      });

      // Clean up filesystem resources
      await engineService.deletePipeline(id);

      // Then delete from database
      await db.deletePipeline(id);
    } catch (error) {
      console.error(`[PipelineService] Error deleting pipeline ${id}:`, error);
      throw error;
    }
  }
} 