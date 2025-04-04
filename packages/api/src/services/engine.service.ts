import { Pipeline, PipelineConfig } from '../models/Pipeline.js';
import { Build, BuildConfig } from '../models/Build.js';
import { PaginatedResult } from '../models/types/index.js';
import { NotFoundError } from '../utils/errors.js';
import { BuildLog } from '../models/BuildLog.js';
import { Artifact } from '../models/Artifact.js';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as mime from 'mime-types';
import { prisma } from '../db.js';
import { DeploymentService } from './deployment.service.js';
import { BillingService } from './billing.service.js';
import { db } from './database.service.js';
import { PrismaClient, PipelineRun, Prisma } from '@prisma/client';

export const buildEvents = new EventEmitter();

interface PaginationOptions {
  page: number;
  limit: number;
  filter?: string;
  sort?: string;
  pipelineId?: string;
}

interface ArtifactCreateOptions {
  buildId: string;
  name: string;
  contentType?: string;
  size: number;
  metadata?: Record<string, string>;
}

interface Step {
  id: string;
  name: string;
  command: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'timed_out';
  environment?: Record<string, string>;
}

export class EngineService {
  private artifactsBaseDir: string;
  private billingService: BillingService;

  constructor(coreEngineUrl: string) {
    this.artifactsBaseDir = process.env.ARTIFACTS_PATH || '/tmp/lightci/artifacts';
    this.billingService = new BillingService(prisma);
  }

  async createPipeline(config: PipelineConfig & { workspaceId: string }): Promise<Pipeline> {
    // TODO: Implement filesystem-based pipeline creation
    throw new Error('Not implemented');
  }

  async getPipeline(id: string): Promise<Pipeline | null> {
    try {
      // Get pipeline from database
      const dbPipeline = await prisma.pipeline.findUnique({
        where: { id },
        include: {
          runs: {
            select: {
              id: true,
              status: true,
              startedAt: true,
              completedAt: true
            },
            orderBy: { startedAt: 'desc' },
            take: 1
          }
        }
      });

      if (!dbPipeline) {
        return null;
      }

      // Transform database pipeline to Pipeline model
      const pipeline: Pipeline = {
        id: dbPipeline.id,
        name: dbPipeline.name,
        repository: dbPipeline.repository,
        workspaceId: 'default', // This is fine as we're only using this for cleanup
        description: dbPipeline.description || undefined,
        defaultBranch: dbPipeline.defaultBranch,
        status: dbPipeline.status as Pipeline['status'],
        steps: typeof dbPipeline.steps === 'string' ? JSON.parse(dbPipeline.steps) : dbPipeline.steps,
        triggers: dbPipeline.triggers ? (typeof dbPipeline.triggers === 'string' ? JSON.parse(dbPipeline.triggers) : dbPipeline.triggers) : undefined,
        schedule: dbPipeline.schedule ? (typeof dbPipeline.schedule === 'string' ? JSON.parse(dbPipeline.schedule) : dbPipeline.schedule) : undefined,
        webhookConfig: dbPipeline.webhookConfig ? (typeof dbPipeline.webhookConfig === 'string' ? JSON.parse(dbPipeline.webhookConfig) : dbPipeline.webhookConfig) : undefined,
        artifactsEnabled: dbPipeline.artifactsEnabled || false,
        artifactPatterns: Array.isArray(dbPipeline.artifactPatterns) ? dbPipeline.artifactPatterns : (typeof dbPipeline.artifactPatterns === 'string' ? JSON.parse(dbPipeline.artifactPatterns) : []),
        artifactRetentionDays: dbPipeline.artifactRetentionDays || 30,
        artifactStorageType: dbPipeline.artifactStorageType || 'local',
        artifactStorageConfig: typeof dbPipeline.artifactStorageConfig === 'string' ? JSON.parse(dbPipeline.artifactStorageConfig) : (dbPipeline.artifactStorageConfig || {}),
        deploymentEnabled: dbPipeline.deploymentEnabled || false,
        deploymentPlatform: dbPipeline.deploymentPlatform || undefined,
        deploymentConfig: typeof dbPipeline.deploymentConfig === 'string' ? JSON.parse(dbPipeline.deploymentConfig) : (dbPipeline.deploymentConfig || {}),
        createdAt: dbPipeline.createdAt,
        updatedAt: dbPipeline.updatedAt,
        createdById: dbPipeline.createdById || 'system'
      };

      return pipeline;
    } catch (error) {
      console.error(`[Engine] Error retrieving pipeline ${id}:`, error);
      throw error; // Propagate error instead of returning null to ensure proper error handling
    }
  }

  async updatePipeline(id: string, config: PipelineConfig): Promise<Pipeline> {
    // TODO: Implement filesystem-based pipeline update
    throw new Error('Not implemented');
  }

  async deletePipeline(id: string): Promise<void> {
    try {
      // Get all runs for this pipeline
      const runs = await prisma.pipelineRun.findMany({
        where: { pipelineId: id },
        include: {
          artifacts: true // Include artifacts to track storage changes
        }
      });

      // Track storage reduction for all artifacts before deletion
      for (const run of runs) {
        for (const artifact of run.artifacts) {
          try {
            await this.billingService.trackArtifactDeletion(artifact.id, artifact.size);
            console.log(`[Engine] Created deletion usage record for artifact ${artifact.id}`);
          } catch (error) {
            console.error(`[Engine] Error tracking deletion for artifact ${artifact.id}:`, error);
            // Continue with other artifacts even if tracking fails
          }
        }
      }

      // Get the artifacts root directory
      const artifactsRoot = process.env.ARTIFACTS_PATH || '/tmp/lightci/artifacts';

      // Delete artifacts for all runs, even if not marked as collected
      for (const run of runs) {
        try {
          // Try both the stored path and the default path
          const artifactPaths = [
            run.artifactsPath,
            path.join(artifactsRoot, run.id)
          ].filter(Boolean);

          for (const artifactPath of artifactPaths) {
            if (artifactPath && fs.existsSync(artifactPath)) {
              console.log(`[Engine] Deleting artifacts directory: ${artifactPath}`);
              await fs.promises.rm(artifactPath, { recursive: true, force: true });
              console.log(`[Engine] Successfully deleted artifacts directory for run ${run.id}`);
            }
          }
        } catch (error) {
          console.error(`[Engine] Error deleting artifacts for run ${run.id}:`, error);
          // Continue with other runs
          console.warn(`[Engine] Continuing deletion process despite artifact deletion error for run ${run.id}`);
        }
      }

      console.log(`[Engine] Successfully cleaned up filesystem resources for pipeline ${id}`);
    } catch (error) {
      console.error(`[Engine] Error cleaning up pipeline ${id}:`, error);
      if (error instanceof Error) {
        console.error(`[Engine] Error stack:`, error.stack);
      }
      throw error;
    }
  }

  // Helper method to delete only artifacts for a run
  private async deleteArtifacts(runId: string): Promise<void> {
    try {
      console.log(`[Engine] Starting deletion of artifacts for run ${runId}`);
      
      // Delete artifacts if they exist
      const run = await prisma.pipelineRun.findUnique({
        where: { id: runId }
      });

      if (run && run.artifactsPath) {
        const artifactPath = run.artifactsPath;
        try {
          if (fs.existsSync(artifactPath)) {
            console.log(`[EngineService] Deleting artifacts at ${artifactPath}`);
            await fs.promises.rm(artifactPath, { recursive: true, force: true });
          }
        } catch (error) {
          console.error(`[EngineService] Error deleting artifacts at ${artifactPath}:`, error);
        }
      }

      console.log(`[Engine] Successfully completed artifact deletion process for run ${runId}`);
    } catch (error) {
      console.error(`[Engine] Error deleting artifacts:`, error);
      throw error;
    }
  }

  async deleteBuild(id: string): Promise<void> {
    try {
      // Delete artifacts first
      await this.deleteArtifacts(id);

      // Then delete the run from the database
      await prisma.pipelineRun.delete({
        where: { id }
      });

      console.log(`[Engine] Successfully deleted build ${id} and its artifacts`);
    } catch (error) {
      console.error(`[Engine] Error deleting build:`, error);
      throw error;
    }
  }

  async getBuild(id: string): Promise<Build | null> {
    try {
      // Get the build from the database
      const run = await prisma.pipelineRun.findUnique({
        where: { id },
        include: {
          pipeline: true
        }
      });
      
      if (!run) {
        return null;
      }

      // Convert to Build format
      return {
        id: run.id,
        pipelineId: run.pipelineId,
        status: run.status as "pending" | "running" | "success" | "failed" | "cancelled",
        branch: run.branch || '',
        commit: run.commit || '',
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString(),
        stepResults: Array.isArray(run.stepResults) ? run.stepResults : (typeof run.stepResults === 'string' ? JSON.parse(run.stepResults) : []),
        createdAt: run.startedAt.toISOString(),
        updatedAt: run.completedAt?.toISOString() || run.startedAt.toISOString()
      };
    } catch (error) {
      console.error('[EngineService] Error getting build:', error);
      return null;
    }
  }

  async updateBuild(id: string, updates: Partial<Build>): Promise<Build> {
    try {
      // Update the pipeline run
      const run = await prisma.pipelineRun.update({
        where: { id },
        data: {
          status: updates.status,
          branch: updates.branch,
          commit: updates.commit,
          completedAt: updates.completedAt ? new Date(updates.completedAt) : undefined,
          stepResults: updates.stepResults || []
        },
        include: {
          pipeline: true
        }
      });

      // Convert to Build format
      return {
        id: run.id,
        pipelineId: run.pipelineId,
        status: run.status as "pending" | "running" | "success" | "failed" | "cancelled",
        branch: run.branch || '',
        commit: run.commit || '',
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString(),
        stepResults: Array.isArray(run.stepResults) ? run.stepResults : (typeof run.stepResults === 'string' ? JSON.parse(run.stepResults) : []),
        createdAt: run.startedAt.toISOString(),
        updatedAt: run.completedAt?.toISOString() || run.startedAt.toISOString()
      };
    } catch (error) {
      console.error('[EngineService] Error updating build:', error);
      throw error;
    }
  }

  async getBuildLogs(buildId: string): Promise<BuildLog[]> {
    // TODO: Implement filesystem-based build log retrieval
    return [];
  }

  async createArtifact(options: ArtifactCreateOptions): Promise<Artifact> {
    const { buildId, name, contentType = 'application/octet-stream', size = 0, metadata = {} } = options;

    // Create artifact directory if it doesn't exist
    const artifactDir = path.join(this.artifactsBaseDir, buildId);
    await fs.promises.mkdir(artifactDir, { recursive: true });

    // Create a placeholder file for now
    // In a real implementation, this would be replaced with actual file content
    const filePath = path.join(artifactDir, name);
    await fs.promises.writeFile(filePath, '');

    // Store relative path instead of absolute path
    const relativePath = name;  // Since we're using the name as the relative path
    const id = `${buildId}-${Buffer.from(relativePath).toString('base64')}`;

    // Create and return the artifact record
    const artifact = await prisma.artifact.create({
      data: {
        id,  // Use our constructed ID
        buildId,
        name,
        contentType,
        size,
        metadata: metadata || Prisma.JsonNull,
        path: relativePath  // Store the relative path
      }
    });

    // Track artifact storage for billing
    try {
      await this.billingService.trackArtifactStorage(artifact.id);
    } catch (error) {
      console.error('[EngineService] Error tracking artifact storage:', error);
      // Don't fail artifact creation if billing tracking fails
    }

    // Cast the Prisma artifact to our domain type
    return {
      id: artifact.id,
      buildId: artifact.buildId,
      name: artifact.name,
      contentType: artifact.contentType || 'application/octet-stream',
      size: artifact.size,
      metadata: (artifact.metadata as Record<string, string>) || {},
      path: artifact.path,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt
    };
  }

  async getBuildArtifacts(buildId: string): Promise<Artifact[]> {
    try {
      // First try to find a pipeline run with this ID
      let run = await prisma.pipelineRun.findUnique({
        where: { id: buildId }
      });

      // If not found, try to find a build and get its associated run
      if (!run) {
        const pipelineRun = await prisma.pipelineRun.findUnique({
          where: { id: buildId }
        });
        run = pipelineRun;
      }

      if (!run || !run.artifactsPath || !run.artifactsCollected) {
        return [];
      }

      // Read all files in the artifacts directory
      const artifacts: Artifact[] = [];
      const files = await this.listFilesRecursively(run.artifactsPath);

      for (const file of files) {
        const relativePath = path.relative(run.artifactsPath, file);
        const stats = await fsPromises.stat(file);
        const mimeType = mime.lookup(file);
        
        artifacts.push({
          id: `${run.id}-${Buffer.from(relativePath).toString('base64')}`,
          buildId: run.id,
          name: path.basename(file),
          path: relativePath,
          size: stats.size,
          contentType: mimeType || null,
          createdAt: stats.birthtime,
          updatedAt: stats.mtime,
          metadata: {}
        });
      }

      return artifacts;
    } catch (error) {
      console.error('[EngineService] Error getting build artifacts:', error);
      return [];
    }
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    try {
      console.log(`[EngineService] Getting artifact with ID: ${id}`);
      
      // First try to get the artifact from the database
      const dbArtifact = await prisma.artifact.findUnique({
        where: { id },
        include: {
          build: true
        }
      });
      
      if (!dbArtifact) {
        console.log(`[EngineService] Artifact not found in database: ${id}`);
        
        // Fall back to the old method of reconstructing from filesystem
        // The ID format is: `${buildId}-${Buffer.from(relativePath).toString('base64')}`
        // But the encoded path might contain hyphens, so we need to split only on the first hyphen
        const firstHyphenIndex = id.indexOf('-');
        if (firstHyphenIndex === -1) {
          console.log(`[EngineService] Invalid artifact ID format: ${id}`);
          return null;
        }
        
        const runId = id.substring(0, firstHyphenIndex);
        const encodedPath = id.substring(firstHyphenIndex + 1);
        
        console.log(`[EngineService] Parsed runId: ${runId}, encodedPath: ${encodedPath}`);
        
        const run = await this.getPipelineRun(runId);
        console.log(`[EngineService] Found run:`, run ? 'yes' : 'no', run?.artifactsPath);
        
        if (!run?.artifactsPath) {
          console.log(`[EngineService] Run or artifactsPath not found`);
          return null;
        }

        const relativePath = Buffer.from(encodedPath, 'base64').toString();
        console.log(`[EngineService] Decoded relativePath: ${relativePath}`);
        
        const fullPath = path.join(run.artifactsPath, relativePath);
        console.log(`[EngineService] Full path: ${fullPath}`);
        
        if (!fs.existsSync(fullPath)) {
          console.log(`[EngineService] File does not exist at path: ${fullPath}`);
          return null;
        }

        console.log(`[EngineService] File exists at path: ${fullPath}`);
        const stats = await fsPromises.stat(fullPath);
        const mimeType = mime.lookup(fullPath);

        return {
          id,
          buildId: runId,
          name: path.basename(fullPath),
          path: relativePath,
          size: stats.size,
          contentType: mimeType || null,
          createdAt: stats.birthtime,
          updatedAt: stats.mtime,
          metadata: {}
        };
      }
      
      // If we found the artifact in the database, use that information
      const run = await this.getPipelineRun(dbArtifact.buildId);
      if (!run?.artifactsPath) {
        console.log(`[EngineService] Run or artifactsPath not found for database artifact`);
        return null;
      }
      
      const fullPath = path.join(run.artifactsPath, dbArtifact.path);
      console.log(`[EngineService] Full path from database: ${fullPath}`);
      
      // Check if the file exists
      if (!fs.existsSync(fullPath)) {
        console.log(`[EngineService] File does not exist at path from database: ${fullPath}`);
        // Still return the artifact info even if the file doesn't exist
      } else {
        console.log(`[EngineService] File exists at path from database: ${fullPath}`);
      }
      
      return {
        id: dbArtifact.id,
        buildId: dbArtifact.buildId,
        name: dbArtifact.name,
        path: dbArtifact.path,
        size: dbArtifact.size,
        contentType: dbArtifact.contentType || null,
        createdAt: dbArtifact.createdAt,
        updatedAt: dbArtifact.updatedAt,
        metadata: (dbArtifact.metadata as Record<string, string>) || {}
      };
    } catch (error) {
      console.error('[EngineService] Error getting artifact:', error);
      return null;
    }
  }

  async deleteArtifact(id: string): Promise<void> {
    const artifact = await this.getArtifact(id);
    if (!artifact) {
      throw new NotFoundError('Artifact not found');
    }

    // Get the run to find the artifact path
    const run = await this.getPipelineRun(artifact.buildId);
    if (!run?.artifactsPath) {
      throw new NotFoundError('Artifact path not found');
    }

    // Track artifact deletion for billing before deleting the artifact
    try {
      await this.billingService.trackArtifactDeletion(id, artifact.size);
    } catch (error) {
      console.error('[EngineService] Error tracking artifact deletion:', error);
      // Don't fail artifact deletion if billing tracking fails
    }

    // Delete the artifact file from storage
    const artifactPath = path.join(run.artifactsPath, artifact.path);
    try {
      await fsPromises.unlink(artifactPath);
    } catch (error) {
      console.warn(`Failed to delete artifact file at ${artifactPath}:`, error);
      throw error;
    }

    // Delete the artifact from the database
    await prisma.artifact.delete({
      where: { id }
    });
  }

  private async listFilesRecursively(dir: string): Promise<string[]> {
    const files: string[] = [];
    
    async function walk(currentDir: string) {
      const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          files.push(fullPath);
        }
      }
    }
    
    await walk(dir);
    return files;
  }

  async getPipelineRun(id: string) {
    try {
      const run = await prisma.pipelineRun.findUnique({
        where: { id }
      });
      return run;
    } catch (error) {
      console.error('[EngineService] Error getting pipeline run:', error);
      return null;
    }
  }
  
  /**
   * Handle a pipeline run completion and trigger deployment if configured
   */
  async handlePipelineRunCompletion(runId: string): Promise<void> {
    console.log(`[EngineService] Handling pipeline run completion for run ${runId}`);
    try {
      // Get the run and pipeline
      console.log(`[EngineService] Fetching pipeline run ${runId} details`);
      const run = await prisma.pipelineRun.findUnique({
        where: { id: runId },
        include: { pipeline: true }
      });
      
      if (!run) {
        console.error(`[EngineService] Cannot handle completion for run ${runId}: Run not found`);
        return;
      }
      
      console.log(`[EngineService] Found pipeline run ${runId} with status ${run.status} for pipeline ${run.pipelineId}`);
      
      // Check if the run is completed successfully
      if (run.status !== 'completed') {
        console.log(`[EngineService] Not triggering deployment for run ${runId}: Status is ${run.status}, not completed`);
        return;
      }
      
      // Check if the pipeline has deployment enabled
      if (!run.pipeline.deploymentEnabled) {
        console.log(`[EngineService] Deployment not enabled for pipeline ${run.pipelineId}`);
        return;
      }
      
      console.log(`[EngineService] Deployment is enabled for pipeline ${run.pipelineId}`);
      
      // Check if we have a deployment platform configured
      if (!run.pipeline.deploymentPlatform) {
        console.log(`[EngineService] No deployment platform configured for pipeline ${run.pipelineId}`);
        return;
      }
      
      console.log(`[EngineService] Triggering deployment for run ${runId} on platform ${run.pipeline.deploymentPlatform}`);
      
      // Initialize deployment service
      console.log(`[EngineService] Initializing DeploymentService`);
      const deploymentService = new DeploymentService(prisma);
      
      // Deploy the pipeline run if deployment is enabled
      if (run.pipeline.deploymentEnabled) {
        const deployConfig = typeof run.pipeline.deploymentConfig === 'string' 
          ? JSON.parse(run.pipeline.deploymentConfig) 
          : (run.pipeline.deploymentConfig || {});
          
        await deploymentService.deployPipelineRun(runId, {
          platform: (run.pipeline.deploymentPlatform as 'aws' | 'aws_ec2' | 'aws_ecs' | 'gcp' | 'azure' | 'kubernetes' | 'custom') || 'aws',
          config: deployConfig
        });
      }
      
      console.log(`[EngineService] Deployment for run ${runId} triggered in the background`);
    } catch (error) {
      console.error(`[EngineService] Error handling pipeline run completion:`, error);
      throw error;
    }
  }
}
