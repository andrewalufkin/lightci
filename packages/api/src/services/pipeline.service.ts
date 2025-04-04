import { db } from './database.service.js';
import { Pipeline, PipelineConfig } from '../models/Pipeline.js';
import { Step } from '../models/Step.js';
import { PaginatedResult } from '../models/types/index.js';
import { DatabasePipeline } from './database.service.js';
import { EngineService } from './engine.service.js';
import { GitHubService } from '../services/github.service.js';
import { SchedulerService } from './scheduler.service.js';
import { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { v4 as crypto } from 'uuid';

export class PipelineService {
  private githubService: GitHubService;
  private engineService: EngineService;
  private schedulerService?: SchedulerService;
  private prismaClient: PrismaClient;

  constructor(
    engineService: EngineService,
    schedulerService?: SchedulerService,
    prismaClient: PrismaClient = prisma
  ) {
    this.githubService = new GitHubService(process.env.API_BASE_URL || 'http://localhost:3000');
    this.engineService = engineService;
    this.schedulerService = schedulerService;
    this.prismaClient = prismaClient;
  }

  private transformToModelPipeline(dbPipeline: any): Pipeline {
    const steps = typeof dbPipeline.steps === 'string' 
      ? JSON.parse(dbPipeline.steps) 
      : (Array.isArray(dbPipeline.steps) ? dbPipeline.steps : []);
    
    return {
      id: dbPipeline.id,
      name: dbPipeline.name,
      repository: dbPipeline.repository,
      workspaceId: 'default', // Default workspace for now
      description: dbPipeline.description || undefined,
      defaultBranch: dbPipeline.defaultBranch,
      status: dbPipeline.status as Pipeline['status'] || 'pending',
      steps: steps,
      triggers: dbPipeline.triggers ? (typeof dbPipeline.triggers === 'string' ? JSON.parse(dbPipeline.triggers) : dbPipeline.triggers) : {},
      schedule: dbPipeline.schedule ? (typeof dbPipeline.schedule === 'string' ? JSON.parse(dbPipeline.schedule) : dbPipeline.schedule) : {},
      webhookConfig: dbPipeline.webhookConfig ? (typeof dbPipeline.webhookConfig === 'string' ? JSON.parse(dbPipeline.webhookConfig) : dbPipeline.webhookConfig) : {},
      artifactsEnabled: dbPipeline.artifactsEnabled || false,
      artifactPatterns: Array.isArray(dbPipeline.artifactPatterns) ? dbPipeline.artifactPatterns : (typeof dbPipeline.artifactPatterns === 'string' ? JSON.parse(dbPipeline.artifactPatterns) : []),
      artifactRetentionDays: dbPipeline.artifactRetentionDays || 30,
      artifactStorageType: dbPipeline.artifactStorageType || 'local',
      artifactStorageConfig: dbPipeline.artifactStorageConfig ? (typeof dbPipeline.artifactStorageConfig === 'string' ? JSON.parse(dbPipeline.artifactStorageConfig) : dbPipeline.artifactStorageConfig) : {},
      deploymentEnabled: dbPipeline.deploymentEnabled || false,
      deploymentMode: dbPipeline.deploymentMode || 'automatic',
      deploymentPlatform: dbPipeline.deploymentPlatform,
      deploymentConfig: dbPipeline.deploymentConfig ? (typeof dbPipeline.deploymentConfig === 'string' ? JSON.parse(dbPipeline.deploymentConfig) : dbPipeline.deploymentConfig) : {},
      createdAt: dbPipeline.createdAt,
      updatedAt: dbPipeline.updatedAt,
      createdById: dbPipeline.createdById
    };
  }

  async getPipeline(id: string, userId: string): Promise<Pipeline | null> {
    const pipeline = await this.prismaClient.pipeline.findFirst({
      where: {
        id,
        createdById: userId
      }
    });

    if (!pipeline) {
      return null;
    }

    return this.transformToModelPipeline(pipeline);
  }

  async listPipelines(options: { 
    page: number; 
    limit: number; 
    userId: string;
    filter?: string; 
  }): Promise<PaginatedResult<Pipeline>> {
    const { page, limit, userId, filter } = options;
    
    const where = {
      createdById: userId,
      ...(filter ? {
        OR: [
          { name: { contains: filter, mode: 'insensitive' as Prisma.QueryMode } },
          { description: { contains: filter, mode: 'insensitive' as Prisma.QueryMode } },
          { repository: { contains: filter, mode: 'insensitive' as Prisma.QueryMode } }
        ]
      } : {})
    };
    
    const skip = (page - 1) * limit;
    const [total, items] = await Promise.all([
      this.prismaClient.pipeline.count({ where }),
      this.prismaClient.pipeline.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      })
    ]);
    
    const transformedItems = items.map(item => this.transformToModelPipeline(item));
    
    return {
      items: transformedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  async createPipeline(config: PipelineConfig, userId: string): Promise<Pipeline> {
    // Validate artifact storage configuration
    if (config.artifactStorageType === 's3' && (!config.artifactStorageConfig || !config.artifactStorageConfig.bucketName)) {
      throw new ValidationError('S3 bucket name is required for S3 artifact storage');
    }

    // Set up webhook configuration if needed
    let webhookConfig = {};
    if (config.repository && config.repository.includes('github.com')) {
      try {
        // Only set up webhook if we have a GitHub token
        if (config.githubToken) {
          console.log(`[PipelineService] Setting up GitHub webhook for repository: ${config.repository}`);
          // Use a method that exists in GitHubService
          webhookConfig = { enabled: true, repository: config.repository };
          console.log(`[PipelineService] Webhook setup successful:`, webhookConfig);
        } else {
          console.log(`[PipelineService] No GitHub token provided, skipping webhook setup`);
        }
      } catch (error) {
        console.error(`[PipelineService] Error setting up webhook:`, error);
        // Don't fail pipeline creation if webhook setup fails
      }
    }

    // Ensure all steps have IDs
    const stepsWithIds = config.steps.map(step => ({
      ...step,
      id: step.id || crypto()
    }));

    // Create the pipeline in the database
    const pipelineData = {
      name: config.name,
      repository: config.repository,
      description: config.description || '',
      defaultBranch: config.defaultBranch || 'main',
      createdById: userId,
      steps: stepsWithIds,
      triggers: config.triggers || {},
      webhookConfig,
      status: 'pending',
      
      // Artifact configuration
      artifactsEnabled: config.artifactsEnabled ?? true,
      artifactPatterns: config.artifactPatterns || [],
      artifactRetentionDays: config.artifactRetentionDays || 30,
      artifactStorageType: config.artifactStorageType || 'local',
      artifactStorageConfig: config.artifactStorageConfig || {},
      
      // Deployment configuration
      deploymentEnabled: config.deploymentEnabled ?? false,
      deploymentMode: config.deploymentMode || 'automatic',
      deploymentPlatform: config.deploymentPlatform,
      deploymentConfig: config.deploymentConfig || {}
    };

    // Create the pipeline in the database
    const created = await this.prismaClient.pipeline.create({
      data: {
        name: pipelineData.name,
        repository: pipelineData.repository,
        description: pipelineData.description,
        defaultBranch: pipelineData.defaultBranch,
        createdBy: {
          connect: {
            id: pipelineData.createdById
          }
        },
        steps: JSON.stringify(pipelineData.steps),
        triggers: JSON.stringify(pipelineData.triggers),
        webhookConfig: JSON.stringify(pipelineData.webhookConfig),
        status: pipelineData.status as Prisma.PipelineCreateInput['status'],
        artifactsEnabled: pipelineData.artifactsEnabled,
        artifactPatterns: JSON.stringify(pipelineData.artifactPatterns),
        artifactRetentionDays: pipelineData.artifactRetentionDays,
        artifactStorageType: pipelineData.artifactStorageType,
        artifactStorageConfig: JSON.stringify(pipelineData.artifactStorageConfig),
        deploymentEnabled: pipelineData.deploymentEnabled,
        deploymentMode: pipelineData.deploymentMode || 'automatic',
        deploymentPlatform: pipelineData.deploymentPlatform || null,
        deploymentConfig: JSON.stringify(pipelineData.deploymentConfig)
      } satisfies Prisma.PipelineCreateInput
    });

    // Set up schedule if needed
    if (config.schedule && this.schedulerService) {
      try {
        const modelPipeline = this.transformToModelPipeline(created);
        await this.schedulerService.updatePipelineSchedule(modelPipeline);
      } catch (error) {
        console.error(`[PipelineService] Error setting up schedule:`, error);
        // Don't fail pipeline creation if schedule setup fails
      }
    }

    return this.transformToModelPipeline(created);
  }

  async updatePipeline(id: string, config: PipelineConfig, userId: string): Promise<Pipeline> {
    // First check if the user owns this pipeline
    const existingPipeline = await this.getPipeline(id, userId);
    if (!existingPipeline) {
      throw new NotFoundError('Pipeline not found or access denied');
    }

    // Validate artifact storage configuration
    if (config.artifactStorageType === 's3' && (!config.artifactStorageConfig || !config.artifactStorageConfig.bucketName)) {
      throw new ValidationError('S3 bucket name is required for S3 artifact storage');
    }

    // Prepare update data
    const updateData: any = {};
    
    // Update basic fields if provided
    if (config.name !== undefined) updateData.name = config.name;
    if (config.repository !== undefined) updateData.repository = config.repository;
    if (config.description !== undefined) updateData.description = config.description;
    if (config.defaultBranch !== undefined) updateData.defaultBranch = config.defaultBranch;
    
    // Update complex fields if provided
    if (config.steps !== undefined) updateData.steps = JSON.stringify(config.steps);
    if (config.triggers !== undefined) updateData.triggers = JSON.stringify(config.triggers);
    
    // Update artifact configuration if provided
    if (config.artifactsEnabled !== undefined) updateData.artifactsEnabled = config.artifactsEnabled;
    if (config.artifactPatterns !== undefined) updateData.artifactPatterns = JSON.stringify(config.artifactPatterns);
    if (config.artifactRetentionDays !== undefined) updateData.artifactRetentionDays = config.artifactRetentionDays;
    if (config.artifactStorageType !== undefined) updateData.artifactStorageType = config.artifactStorageType;
    if (config.artifactStorageConfig !== undefined) updateData.artifactStorageConfig = JSON.stringify(config.artifactStorageConfig);
    
    // Update deployment configuration if provided
    if (config.deploymentEnabled !== undefined) updateData.deploymentEnabled = config.deploymentEnabled;
    if (config.deploymentMode !== undefined) updateData.deploymentMode = config.deploymentMode;
    if (config.deploymentPlatform !== undefined) updateData.deploymentPlatform = config.deploymentPlatform;
    if (config.deploymentConfig !== undefined) updateData.deploymentConfig = JSON.stringify(config.deploymentConfig);

    try {
      // Update the pipeline in the database
      const updated = await this.prismaClient.pipeline.update({
        where: { id },
        data: updateData
      });

      return this.transformToModelPipeline(updated);
    } catch (error) {
      console.error(`[PipelineService] Error updating pipeline:`, error);
      throw new Error('Failed to update pipeline');
    }
  }

  async deletePipeline(id: string, userId: string): Promise<void> {
    const existingPipeline = await this.getPipeline(id, userId);
    if (!existingPipeline) {
      throw new NotFoundError('Pipeline not found or access denied');
    }

    try {
      // Import required services for cleanup
      const { InstanceProvisionerService } = await import('./instance-provisioner.service.js');
      const { config } = await import('../config/config.js');
      
      // Find any active auto deployments for this pipeline
      const autoDeployments = await this.prismaClient.autoDeployment.findMany({
        where: { 
          pipelineId: id,
          status: 'active'
        }
      });
      
      // Clean up EC2 instances and update deployment records
      if (autoDeployments.length > 0) {
        console.log(`[PipelineService] Found ${autoDeployments.length} active deployments to clean up`);
        
        // Parse deployment config to get AWS credentials
        let awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
        let awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
        let region = process.env.AWS_DEFAULT_REGION || 'us-east-1';
        
        // Try to get credentials from pipeline config
        if (existingPipeline.deploymentConfig) {
          try {
            const deploymentConfig = typeof existingPipeline.deploymentConfig === 'string' 
              ? JSON.parse(existingPipeline.deploymentConfig) 
              : existingPipeline.deploymentConfig;
              
            // Check for AWS credentials in various locations
            awsAccessKeyId = deploymentConfig.awsAccessKeyId || 
                            deploymentConfig.config?.awsAccessKeyId || 
                            awsAccessKeyId;
                            
            awsSecretAccessKey = deploymentConfig.awsSecretAccessKey || 
                                deploymentConfig.config?.awsSecretAccessKey || 
                                awsSecretAccessKey;
                                
            region = deploymentConfig.region || 
                    deploymentConfig.config?.region || 
                    region;
          } catch (error) {
            console.error('[PipelineService] Error parsing deployment config:', error);
          }
        }
        
        // Create instance provisioner service with correct instance config
        const instanceProvisioner = new InstanceProvisionerService(
          this.prismaClient,
          {
            region,
            imageId: 'ami-0889a44b331db0194',
            keyName: '',
            securityGroupIds: [],
            subnetId: ''
          },
          awsAccessKeyId,
          awsSecretAccessKey
        );
        
        // Terminate each instance and update deployment records
        for (const deployment of autoDeployments) {
          try {
            console.log(`[PipelineService] Terminating EC2 instance for deployment ${deployment.id}`);
            await instanceProvisioner.terminateInstance(deployment.id);
            console.log(`[PipelineService] Successfully terminated EC2 instance for deployment ${deployment.id}`);
          } catch (error) {
            console.error(`[PipelineService] Error terminating EC2 instance:`, error);
            
            // Even if EC2 termination fails, update the database record
            const currentMetadata = deployment.metadata || {};
            const updatedMetadata = {
              ...(typeof currentMetadata === 'object' ? currentMetadata : {}),
              terminatedAt: new Date().toISOString(),
              terminatedBy: 'pipeline-deletion',
              terminationError: error instanceof Error ? error.message : 'Unknown error'
            };
            
            await this.prismaClient.autoDeployment.update({
              where: { id: deployment.id },
              data: {
                status: 'terminated',
                metadata: updatedMetadata
              }
            });
          }
        }
      }
      
      // Clean up deployed app records
      await this.prismaClient.deployedApp.deleteMany({
        where: { pipelineId: id }
      });
      
      // Delete all associated pipeline runs
      await this.prismaClient.pipelineRun.deleteMany({
        where: { pipelineId: id }
      });

      // Delete the pipeline
      await this.prismaClient.pipeline.delete({
        where: { id }
      });
      
      console.log(`[PipelineService] Successfully deleted pipeline ${id} with all associated resources`);
    } catch (error) {
      console.error(`[PipelineService] Error deleting pipeline:`, error);
      throw new Error('Failed to delete pipeline');
    }
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
    const pipeline = await this.prismaClient.pipeline.findFirst({
      where: {
        repository: normalizedUrl
      }
    });
    
    if (pipeline) {
      if (!pipeline.createdById) {
        throw new Error('Pipeline is missing required createdById field');
      }
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
        deploymentMode: pipeline.deploymentMode || 'automatic',
        deploymentPlatform: pipeline.deploymentPlatform || undefined,
        deploymentConfig: pipeline.deploymentConfig,
        createdById: pipeline.createdById
      };
    }
    
    // If not found and we have a repo name, try more flexible matching
    if (repoName) {
      console.log(`[PipelineService] Trying flexible matching with repo name: ${repoName}`);
      
      // Get all pipelines (limited to avoid performance issues)
      const pipelines = await this.prismaClient.pipeline.findMany({
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
        if (!matchingPipeline.createdById) {
          throw new Error('Pipeline is missing required createdById field');
        }
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
          deploymentMode: matchingPipeline.deploymentMode || 'automatic',
          deploymentPlatform: matchingPipeline.deploymentPlatform || undefined,
          deploymentConfig: matchingPipeline.deploymentConfig,
          createdById: matchingPipeline.createdById
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
    try {
      // Create the pipeline run with explicit transaction to ensure it's committed
      const pipelineRun = await this.prismaClient.$transaction(async (tx) => {
        console.log(`[PipelineService] Starting transaction to create pipeline run...`);
        
        const run = await tx.pipelineRun.create({
          data: {
            pipelineId: config.pipelineId,
            branch: config.branch,
            commit: config.commit,
            status: 'running', // Always set to running initially
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