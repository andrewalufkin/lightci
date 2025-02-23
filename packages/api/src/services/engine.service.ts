import { Pipeline, PipelineConfig } from '../models/Pipeline';
import { Build, BuildConfig } from '../models/Build';
import { PaginatedResult } from '../models/types';
import { NotFoundError } from '../utils/errors';
import { BuildLog } from '../models/BuildLog';
import { Artifact } from '../models/Artifact';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as mime from 'mime-types';
import { prisma } from '../db';

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

  constructor(coreEngineUrl: string) {
    this.artifactsBaseDir = process.env.ARTIFACTS_ROOT || '/tmp/lightci/artifacts';
  }

  async listPipelines(options: PaginationOptions): Promise<PaginatedResult<Pipeline>> {
    // TODO: Implement filesystem-based pipeline listing
    return {
      items: [],
      total: 0,
      page: options.page,
      limit: options.limit,
    };
  }

  async createPipeline(config: PipelineConfig & { workspaceId: string }): Promise<Pipeline> {
    // TODO: Implement filesystem-based pipeline creation
    throw new Error('Not implemented');
  }

  async getPipeline(id: string): Promise<Pipeline | null> {
    try {
      console.log(`[Engine] Looking up pipeline ${id} in database`);
      
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
        console.log(`[Engine] Pipeline ${id} not found in database`);
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
        artifactsEnabled: dbPipeline.artifactsEnabled,
        artifactPatterns: dbPipeline.artifactPatterns ? (typeof dbPipeline.artifactPatterns === 'string' ? JSON.parse(dbPipeline.artifactPatterns) : dbPipeline.artifactPatterns) : [],
        artifactRetentionDays: dbPipeline.artifactRetentionDays,
        artifactStorageType: dbPipeline.artifactStorageType,
        artifactStorageConfig: dbPipeline.artifactStorageConfig ? (typeof dbPipeline.artifactStorageConfig === 'string' ? JSON.parse(dbPipeline.artifactStorageConfig) : dbPipeline.artifactStorageConfig) : {},
        createdAt: dbPipeline.createdAt,
        updatedAt: dbPipeline.updatedAt
      };

      console.log(`[Engine] Successfully retrieved pipeline ${id} from database`);
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
      // Get the pipeline and all its runs with full details
      const pipeline = await this.getPipeline(id);
      console.log(`[Engine] Starting deletion of pipeline ${id}. Pipeline exists: ${!!pipeline}`);
      
      // Modified query to ensure we get ALL runs for this pipeline
      const runs = await prisma.pipelineRun.findMany({
        where: { 
          OR: [
            { pipelineId: id },
            { pipeline: { id: id } }
          ]
        },
        select: {
          id: true,
          artifactsPath: true,
          artifactsCollected: true,
          pipeline: {
            select: {
              id: true
            }
          }
        }
      });
      
      console.log(`[Engine] Found ${runs.length} runs for pipeline ${id}. Run IDs:`, runs.map(r => r.id));

      const workspacesRoot = process.env.WORKSPACE_ROOT || '/tmp/lightci/workspaces';
      const artifactsRoot = process.env.ARTIFACTS_ROOT || '/tmp/lightci/artifacts';

      // Delete workspace if it exists
      if (pipeline?.workspaceId) {
        const workspacePath = path.join(workspacesRoot, pipeline.workspaceId);
        if (fs.existsSync(workspacePath)) {
          await fs.promises.rm(workspacePath, { recursive: true, force: true });
          console.log(`[Engine] Deleted workspace directory for pipeline ${id}`);
        }
      }

      // Delete artifacts for all runs, even if not marked as collected
      for (const run of runs) {
        try {
          // Try both the stored path and the default path
          const artifactPaths = [
            run.artifactsPath,
            path.join(artifactsRoot, run.id)
          ].filter(Boolean);

          for (const artifactPath of artifactPaths) {
            if (fs.existsSync(artifactPath)) {
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
      
      // Find the pipeline run with full artifact path
      const run = await prisma.pipelineRun.findUnique({
        where: { id: runId },
        select: {
          id: true,
          artifactsPath: true,
          artifactsCollected: true
        }
      });

      if (!run) {
        throw new NotFoundError('Run not found');
      }

      // If the run has artifacts, delete them from the filesystem
      if (run.artifactsCollected && run.artifactsPath) {
        try {
          // Ensure we have the full absolute path
          const fullArtifactsPath = path.isAbsolute(run.artifactsPath) 
            ? run.artifactsPath 
            : path.join(this.artifactsBaseDir, runId);

          console.log(`[Engine] Checking artifacts path: ${fullArtifactsPath}`);
          const exists = await fsPromises.access(fullArtifactsPath)
            .then(() => true)
            .catch(() => false);
            
          if (exists) {
            console.log(`[Engine] Deleting artifacts directory: ${fullArtifactsPath}`);
            await fsPromises.rm(fullArtifactsPath, { recursive: true, force: true });
            console.log(`[Engine] Successfully deleted artifacts directory for run ${runId}`);
          } else {
            console.log(`[Engine] Artifacts directory does not exist: ${fullArtifactsPath}`);
          }
        } catch (error) {
          console.error(`[Engine] Error deleting artifacts directory for run ${runId}:`, error);
          throw error; // Throw error to ensure proper cleanup
        }
      } else {
        console.log(`[Engine] No artifacts to clean up for run ${runId}`);
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

  async listBuilds(options: PaginationOptions): Promise<PaginatedResult<Build>> {
    // TODO: Implement filesystem-based build listing
    return {
      items: [],
      total: 0,
      page: options.page,
      limit: options.limit,
    };
  }

  async createBuild(config: BuildConfig): Promise<Build> {
    // TODO: Implement filesystem-based build creation
    throw new Error('Not implemented');
  }

  async getBuild(id: string): Promise<Build | null> {
    try {
      // First try to find a pipeline run with this ID
      const run = await prisma.pipelineRun.findUnique({
        where: { id },
        include: {
          pipeline: true
        }
      });
      
      if (!run) {
        return null;
      }

      // Transform pipeline run into build format
      const build: Build = {
        id: run.id,
        pipelineId: run.pipelineId,
        status: run.status as any, // Convert status to match Build status type
        branch: run.branch || 'main',
        commit: run.commit || '',
        // Use startedAt as createdAt since that's when the run was created
        createdAt: typeof run.startedAt === 'string' ? run.startedAt : run.startedAt.toISOString(),
        // Use completedAt as updatedAt if available, otherwise use startedAt
        updatedAt: run.completedAt 
          ? (typeof run.completedAt === 'string' ? run.completedAt : run.completedAt.toISOString())
          : (typeof run.startedAt === 'string' ? run.startedAt : run.startedAt.toISOString()),
        startedAt: typeof run.startedAt === 'string' ? run.startedAt : run.startedAt.toISOString(),
        completedAt: run.completedAt 
          ? (typeof run.completedAt === 'string' ? run.completedAt : run.completedAt.toISOString())
          : undefined,
        stepResults: run.stepResults || []
      };

      return build;
    } catch (error) {
      console.error('[EngineService] Error getting build:', error);
      return null;
    }
  }

  async updateBuild(id: string, updates: Partial<Build>): Promise<Build> {
    // TODO: Implement filesystem-based build update
    throw new Error('Not implemented');
  }

  async getBuildLogs(buildId: string): Promise<BuildLog[]> {
    // TODO: Implement filesystem-based build log retrieval
    return [];
  }

  async createArtifact(options: ArtifactCreateOptions): Promise<Artifact> {
    // TODO: Implement filesystem-based artifact creation
    throw new Error('Not implemented');
  }

  async getBuildArtifacts(buildId: string): Promise<Artifact[]> {
    try {
      // First try to find a pipeline run with this ID
      let run = await prisma.pipelineRun.findUnique({
        where: { id: buildId }
      });

      // If not found, try to find a build and get its associated run
      if (!run) {
        const build = await prisma.build.findUnique({
          where: { id: buildId },
          include: {
            pipelineRun: true
          }
        });
        run = build?.pipelineRun;
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
        
        artifacts.push({
          id: `${run.id}-${Buffer.from(relativePath).toString('base64')}`,
          buildId: run.id,
          name: path.basename(file),
          path: relativePath,
          size: stats.size,
          contentType: mime.lookup(file) || undefined,
          createdAt: stats.birthtime
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
      
      // ID format is "{buildId}-{base64EncodedPath}"
      const [buildId, encodedPath] = id.split('-');
      if (!buildId || !encodedPath) {
        console.log(`[EngineService] Invalid artifact ID format: ${id}`);
        return null;
      }

      const relativePath = Buffer.from(encodedPath, 'base64').toString();
      console.log(`[EngineService] Decoded path: ${relativePath}`);
      
      // Get the pipeline run from the database
      const run = await prisma.pipelineRun.findUnique({
        where: { id: buildId }
      });
      console.log(`[EngineService] Pipeline run lookup result:`, run);

      if (!run || !run.artifactsPath || !run.artifactsCollected) {
        console.log(`[EngineService] Run not found or artifacts not available for ID: ${buildId}`);
        return null;
      }

      const fullPath = path.join(run.artifactsPath, relativePath);
      console.log(`[EngineService] Full artifact path: ${fullPath}`);
      
      // Check if file exists and get its stats
      const stats = await fsPromises.stat(fullPath);
      
      const artifact = {
        id,
        buildId,
        name: path.basename(fullPath),
        path: relativePath,
        size: stats.size,
        contentType: mime.lookup(fullPath) || undefined,
        createdAt: stats.birthtime
      };
      
      console.log(`[EngineService] Found artifact:`, artifact);
      return artifact;
    } catch (error) {
      console.error('[EngineService] Error getting artifact:', error);
      return null;
    }
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
}
