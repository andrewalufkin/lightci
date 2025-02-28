import { db } from './database.service';
import { Pipeline, PipelineConfig } from '../models/Pipeline';
import { Step } from '../models/Step';
import { PaginatedResult } from '../models/types';
import { PrismaClient } from '@prisma/client';
import { DatabasePipeline } from './database.service';
import { EngineService } from './engine.service';
import { GitHubService } from '../services/github.service';

const prisma = new PrismaClient();

export class PipelineService {
  private githubService: GitHubService;
  private engineService: EngineService;

  constructor(engineService: EngineService) {
    this.githubService = new GitHubService(process.env.API_BASE_URL || 'http://localhost:3000');
    this.engineService = engineService;
  }

  private async transformToModelPipeline(dbPipeline: DatabasePipeline): Promise<Pipeline> {
    // Get the latest run for this pipeline
    const latestRun = await prisma.pipelineRun.findFirst({
      where: { pipelineId: dbPipeline.id },
      orderBy: { startedAt: 'desc' }
    });

    // Parse the steps from the pipeline
    const steps = (typeof dbPipeline.steps === 'string' ? JSON.parse(dbPipeline.steps) : dbPipeline.steps) as Step[];

    // Parse the triggers if they exist
    const triggers = dbPipeline.triggers ? (typeof dbPipeline.triggers === 'string' ? JSON.parse(dbPipeline.triggers) : dbPipeline.triggers) : undefined;

    // Parse the schedule if it exists
    const schedule = dbPipeline.schedule ? (typeof dbPipeline.schedule === 'string' ? JSON.parse(dbPipeline.schedule) : dbPipeline.schedule) : undefined;

    // Parse the webhook config if it exists
    const webhookConfig = dbPipeline.webhookConfig ? (typeof dbPipeline.webhookConfig === 'string' ? JSON.parse(dbPipeline.webhookConfig) : dbPipeline.webhookConfig) : undefined;

    // If we have a latest run, update the step statuses from it
    if (latestRun) {
      console.log('[PipelineService] Found latest run:', {
        runId: latestRun.id,
        status: latestRun.status,
        stepResults: latestRun.stepResults
      });

      const latestStepResults = Array.isArray(latestRun.stepResults) 
        ? latestRun.stepResults 
        : (typeof latestRun.stepResults === 'string' 
          ? JSON.parse(latestRun.stepResults) 
          : []);

      console.log('[PipelineService] Parsed step results:', latestStepResults);

      // Track if we've encountered a failure
      let hasFailedStep = false;

      // Update each step's status from the latest run
      steps.forEach(step => {
        console.log('[PipelineService] Processing step:', {
          stepName: step.name,
          stepId: step.id,
          currentStatus: step.status
        });

        const latestStepResult = latestStepResults.find(sr => 
          (step.id && sr.id === step.id) || (!step.id && sr.name === step.name)
        );

        console.log('[PipelineService] Found matching step result:', {
          stepName: step.name,
          latestStepResult: latestStepResult
        });

        if (latestStepResult) {
          // Only set status if the step has actually started running
          if (latestStepResult.status !== 'pending') {
            console.log('[PipelineService] Updating step status:', {
              stepName: step.name,
              oldStatus: step.status,
              newStatus: latestStepResult.status,
              error: latestStepResult.error
            });

            step.status = latestStepResult.status;
            step.duration = latestStepResult.duration;
            step.error = latestStepResult.error;

            if (latestStepResult.status === 'failed') {
              hasFailedStep = true;
              // Ensure the failed step shows as failed, not running
              step.status = 'failed';
              console.log('[PipelineService] Step failed:', {
                stepName: step.name,
                finalStatus: step.status,
                error: step.error
              });
            }
          } else {
            console.log('[PipelineService] Step is still pending:', {
              stepName: step.name,
              status: latestStepResult.status
            });
          }
        } else if (hasFailedStep) {
          // Don't set any status for steps after a failure
          delete step.status;
          console.log('[PipelineService] Removed status for step after failure:', {
            stepName: step.name
          });
        }
      });

      console.log('[PipelineService] Final steps state:', steps.map(s => ({
        name: s.name,
        status: s.status,
        error: s.error
      })));
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
      triggers: triggers,
      schedule: schedule,
      webhookConfig: webhookConfig,
      
      // Artifact configuration
      artifactsEnabled: dbPipeline.artifactsEnabled,
      artifactPatterns: dbPipeline.artifactPatterns || [],
      artifactRetentionDays: dbPipeline.artifactRetentionDays || 30,
      artifactStorageType: dbPipeline.artifactStorageType || 'local',
      artifactStorageConfig: dbPipeline.artifactStorageConfig || {},
      
      // Deployment configuration
      deploymentEnabled: dbPipeline.deploymentEnabled || false,
      deploymentPlatform: dbPipeline.deploymentPlatform,
      deploymentConfig: dbPipeline.deploymentConfig || {},
      
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
    // Validate artifact storage configuration
    if (config.artifactStorageType === 's3') {
      if (!config.artifactStorageConfig?.bucketName) {
        throw new Error('S3 storage requires bucketName configuration');
      }
      if (!config.artifactStorageConfig?.region) {
        throw new Error('S3 storage requires region configuration');
      }
      if (!config.artifactStorageConfig?.credentialsId) {
        throw new Error('S3 storage requires credentialsId configuration');
      }
    }

    // Check if we need to set up webhooks
    let webhookConfig = {};
    if (config.triggers?.events?.includes('push')) {
      if (!config.githubToken) {
        throw new Error('GitHub token is required when using push triggers');
      }

      try {
        // Create GitHub webhook with the provided token
        const webhook = await this.githubService.createWebhook(config.repository, config.githubToken);
        webhookConfig = {
          github: {
            id: webhook.id,
            url: webhook.url
          }
        };
      } catch (error) {
        console.error('Failed to create GitHub webhook:', error);
        throw new Error('Failed to create GitHub webhook. Please ensure you have the correct permissions.');
      }
    }

    // Remove the token before storing the pipeline configuration
    const { githubToken, ...pipelineData } = config;

    const pipeline = {
      ...pipelineData,
      name: config.name,
      repository: config.repository,
      description: config.description,
      defaultBranch: config.defaultBranch || 'main',
      steps: config.steps.map(step => ({
        id: step.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        name: step.name,
        command: step.command,
        environment: step.environment || {},
        runOnDeployedInstance: step.runOnDeployedInstance,
        runLocation: step.runLocation
      })),
      triggers: config.triggers,
      webhookConfig,
      
      // Artifact configuration
      artifactsEnabled: config.artifactsEnabled ?? true,
      artifactPatterns: config.artifactPatterns ?? [],
      artifactRetentionDays: config.artifactRetentionDays ?? 30,
      artifactStorageType: config.artifactStorageType ?? 'local',
      artifactStorageConfig: config.artifactStorageConfig ?? {},
      
      // Deployment configuration
      deploymentEnabled: config.deploymentEnabled ?? false,
      deploymentPlatform: config.deploymentPlatform,
      deploymentConfig: config.deploymentConfig ?? {}
    };

    const created = await db.createPipeline(pipeline);
    return this.transformToModelPipeline(created);
  }

  async updatePipeline(id: string, config: PipelineConfig): Promise<Pipeline> {
    // Validate artifact storage configuration
    if (config.artifactStorageType === 's3') {
      if (!config.artifactStorageConfig?.bucketName) {
        throw new Error('S3 storage requires bucketName configuration');
      }
      if (!config.artifactStorageConfig?.region) {
        throw new Error('S3 storage requires region configuration');
      }
      if (!config.artifactStorageConfig?.credentialsId) {
        throw new Error('S3 storage requires credentialsId configuration');
      }
    }

    const pipeline: Partial<Omit<DatabasePipeline, 'id' | 'createdAt' | 'updatedAt'>> = {
      name: config.name,
      repository: config.repository,
      description: config.description,
      defaultBranch: config.defaultBranch,
      steps: config.steps.map(step => ({
        id: `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        name: step.name,
        command: step.command,
        environment: step.environment || {},
        runOnDeployedInstance: step.runOnDeployedInstance,
        runLocation: step.runLocation
      })),
      
      // Artifact configuration
      artifactsEnabled: config.artifactsEnabled ?? true,
      artifactPatterns: config.artifactPatterns ?? [],
      artifactRetentionDays: config.artifactRetentionDays ?? 30,
      artifactStorageType: config.artifactStorageType ?? 'local',
      artifactStorageConfig: config.artifactStorageConfig ?? {},
      
      // Deployment configuration
      deploymentEnabled: config.deploymentEnabled ?? false,
      deploymentPlatform: config.deploymentPlatform,
      deploymentConfig: config.deploymentConfig ?? {}
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

      // Delete webhook if it exists
      const webhookConfig = pipeline.webhookConfig ? (typeof pipeline.webhookConfig === 'string' ? JSON.parse(pipeline.webhookConfig) : pipeline.webhookConfig) : undefined;
      if (webhookConfig?.github?.id) {
        try {
          // Since we don't store the token, we'll need to use the environment variable as fallback
          const token = process.env.GITHUB_TOKEN;
          if (!token) {
            console.warn('No GitHub token available to delete webhook');
          } else {
            await this.githubService.deleteWebhook(pipeline.repository, webhookConfig.github.id, token);
          }
        } catch (error) {
          console.error('Failed to delete GitHub webhook:', error);
          // Continue with pipeline deletion even if webhook deletion fails
        }
      }

      // Clean up filesystem resources and runs
      await this.engineService.deletePipeline(id);

      // Delete from database
      await db.deletePipeline(id);
    } catch (error) {
      console.error(`[PipelineService] Error deleting pipeline ${id}:`, error);
      throw error;
    }
  }
} 