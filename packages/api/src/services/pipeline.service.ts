import { db } from './database.service';
import { Pipeline, PipelineConfig } from '../models/Pipeline';
import { Step } from '../models/Step';
import { PaginatedResult } from '../models/types';
import { DatabasePipeline } from './database.service';
import { EngineService } from './engine.service';
import { GitHubService } from '../services/github.service';
import { SchedulerService } from './scheduler.service';
import { prisma } from '../lib/prisma';

export class PipelineService {
  private githubService: GitHubService;
  private engineService: EngineService;
  private schedulerService?: SchedulerService;

  constructor(engineService: EngineService, schedulerService?: SchedulerService) {
    this.githubService = new GitHubService(process.env.API_BASE_URL || 'http://localhost:3000');
    this.engineService = engineService;
    this.schedulerService = schedulerService;
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

        const latestStepResult = latestStepResults.find((sr: { id?: string; name: string; status: string }) => 
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
          step.status = undefined;
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

  async listPipelines(options: { page: number; limit: number; filter?: string; sort?: string; userId: string; }): Promise<PaginatedResult<Pipeline>> {
    const pipelines = await db.listPipelines({
      ...options,
      where: { createdById: options.userId }
    });
    const transformedPipelines = await Promise.all(pipelines.items.map(p => this.transformToModelPipeline(p)));
    return {
      ...pipelines,
      items: transformedPipelines
    };
  }

  async getPipeline(id: string, userId: string): Promise<Pipeline | null> {
    const pipeline = await db.getPipeline(id, userId);
    if (!pipeline) return null;
    return this.transformToModelPipeline(pipeline);
  }

  async createPipeline(config: PipelineConfig, userId: string): Promise<Pipeline> {
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
      createdById: userId,
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

  async updatePipeline(id: string, config: PipelineConfig, userId: string): Promise<Pipeline> {
    // First check if the user owns this pipeline
    const existingPipeline = await db.getPipeline(id, userId);
    if (!existingPipeline) {
      throw new Error('Pipeline not found or access denied');
    }

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
      schedule: config.schedule,
      
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
    const modelPipeline = await this.transformToModelPipeline(updated);

    // Update schedule if scheduler service is available
    if (this.schedulerService && modelPipeline.schedule) {
      await this.schedulerService.updatePipelineSchedule(modelPipeline);
    }

    return modelPipeline;
  }

  async deletePipeline(id: string, userId: string): Promise<void> {
    // First check if the user owns this pipeline
    const existingPipeline = await db.getPipeline(id, userId);
    if (!existingPipeline) {
      throw new Error('Pipeline not found or access denied');
    }
    await db.deletePipeline(id);
  }

  /**
   * Finds a pipeline by repository URL
   * This accounts for different URL formats (github.com, gitlab.com)
   */
  public async findPipelineByRepository(repositoryUrl: string): Promise<DatabasePipeline | null> {
    // Normalize repository URL by removing .git suffix and trailing slashes
    const normalizedUrl = repositoryUrl.replace(/\.git$/, '').replace(/\/$/, '');
    
    // Extract repository name for more flexible matching
    const repoMatch = normalizedUrl.match(/([^\/]+\/[^\/]+)$/);
    const repoName = repoMatch ? repoMatch[1] : '';
    
    // Log the repository URL for debugging
    console.log(`[PipelineService] Finding pipeline for repository: ${normalizedUrl}`);
    
    // Try to find by exact URL first
    const pipeline = await prisma.pipeline.findFirst({
      where: {
        repository: normalizedUrl
      }
    });
    
    if (pipeline) {
      return {
        id: pipeline.id,
        name: pipeline.name,
        repository: pipeline.repository,
        description: pipeline.description || undefined,
        defaultBranch: pipeline.defaultBranch,
        steps: pipeline.steps,
        triggers: pipeline.triggers,
        schedule: pipeline.schedule,
        webhookConfig: pipeline.webhookConfig,
        status: pipeline.status,
        createdAt: pipeline.createdAt,
        updatedAt: pipeline.updatedAt,
        artifactsEnabled: pipeline.artifactsEnabled,
        artifactPatterns: pipeline.artifactPatterns,
        artifactRetentionDays: pipeline.artifactRetentionDays,
        artifactStorageType: pipeline.artifactStorageType,
        artifactStorageConfig: pipeline.artifactStorageConfig,
        deploymentEnabled: pipeline.deploymentEnabled,
        deploymentPlatform: pipeline.deploymentPlatform || undefined,
        deploymentConfig: pipeline.deploymentConfig
      };
    }
    
    // If not found and we have a repo name, try more flexible matching
    if (repoName) {
      console.log(`[PipelineService] Trying flexible matching with repo name: ${repoName}`);
      
      // Get all pipelines (limited to avoid performance issues)
      const pipelines = await prisma.pipeline.findMany({
        take: 10,
        orderBy: {
          updatedAt: 'desc'
        }
      });
      
      // Find a pipeline where the repository URL contains the same repo name
      const matchingPipeline = pipelines.find(p => {
        const pipelineRepoMatch = p.repository.match(/([^\/]+\/[^\/]+)(?:\.git)?$/);
        const pipelineRepoName = pipelineRepoMatch ? pipelineRepoMatch[1] : '';
        return pipelineRepoName === repoName;
      });
      
      if (matchingPipeline) {
        console.log(`[PipelineService] Found matching pipeline through flexible matching: ${matchingPipeline.id}`);
        return {
          id: matchingPipeline.id,
          name: matchingPipeline.name,
          repository: matchingPipeline.repository,
          description: matchingPipeline.description || undefined,
          defaultBranch: matchingPipeline.defaultBranch,
          steps: matchingPipeline.steps,
          triggers: matchingPipeline.triggers,
          schedule: matchingPipeline.schedule,
          webhookConfig: matchingPipeline.webhookConfig,
          status: matchingPipeline.status,
          createdAt: matchingPipeline.createdAt,
          updatedAt: matchingPipeline.updatedAt,
          artifactsEnabled: matchingPipeline.artifactsEnabled,
          artifactPatterns: matchingPipeline.artifactPatterns,
          artifactRetentionDays: matchingPipeline.artifactRetentionDays,
          artifactStorageType: matchingPipeline.artifactStorageType,
          artifactStorageConfig: matchingPipeline.artifactStorageConfig,
          deploymentEnabled: matchingPipeline.deploymentEnabled,
          deploymentPlatform: matchingPipeline.deploymentPlatform || undefined,
          deploymentConfig: matchingPipeline.deploymentConfig
        };
      }
    }
    
    console.log(`[PipelineService] No matching pipeline found for repository: ${normalizedUrl}`);
    return null;
  }

  /**
   * Creates a new pipeline run
   */
  async createPipelineRun(config: {
    pipelineId: string;
    branch: string;
    commit: string;
    status: string;
    triggeredBy: string;
    repository: string;
    prNumber?: number;
  }): Promise<{ id: string }> {
    console.log(`[PipelineService] Creating pipeline run with config:`, config);

    try {
      // Create the pipeline run with explicit transaction to ensure it's committed
      const pipelineRun = await prisma.$transaction(async (tx) => {
        console.log(`[PipelineService] Starting transaction to create pipeline run...`);
        
        const run = await tx.pipelineRun.create({
          data: {
            pipelineId: config.pipelineId,
            branch: config.branch,
            commit: config.commit,
            status: config.status || 'pending',
            startedAt: new Date(),
            stepResults: [],
            logs: []
          }
        });
        
        console.log(`[PipelineService] Created pipeline run in transaction:`, {
          id: run.id,
          pipelineId: run.pipelineId,
          branch: run.branch,
          commit: run.commit,
          status: run.status
        });
        
        return run;
      });
      
      console.log(`[PipelineService] Transaction completed, pipeline run created with ID: ${pipelineRun.id}`);
      return { id: pipelineRun.id };
    } catch (error) {
      console.error(`[PipelineService] Error creating pipeline run:`, error);
      throw error;
    }
  }
} 