import { Pipeline, PipelineConfig } from '../models/Pipeline';
import { Build, BuildConfig } from '../models/Build';
import { PaginatedResult } from '../models/types';
import { NotFoundError } from '../utils/errors';
import { BuildLog } from '../models/BuildLog';
import { Artifact } from '../models/Artifact';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';

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
  constructor() {
    // Initialize any necessary filesystem-related setup
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
      // Check if pipeline workspace exists
      const workspacesRoot = process.env.WORKSPACE_ROOT || '/tmp/lightci/workspaces';
      const workspaces = await fs.promises.readdir(workspacesRoot);
      
      // Look for a workspace containing this pipeline
      for (const workspaceId of workspaces) {
        const pipelineConfigPath = path.join(workspacesRoot, workspaceId, 'pipeline.json');
        if (fs.existsSync(pipelineConfigPath)) {
          const configContent = await fs.promises.readFile(pipelineConfigPath, 'utf-8');
          const config = JSON.parse(configContent);
          if (config.id === id) {
            return {
              id,
              workspaceId,
              ...config
            };
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error(`[Engine] Error retrieving pipeline ${id}:`, error);
      return null;
    }
  }

  async updatePipeline(id: string, config: PipelineConfig): Promise<Pipeline> {
    // TODO: Implement filesystem-based pipeline update
    throw new Error('Not implemented');
  }

  async deletePipeline(id: string): Promise<void> {
    try {
      // Get the pipeline's workspace directory path
      const pipeline = await this.getPipeline(id);
      const workspacesRoot = process.env.WORKSPACE_ROOT || '/tmp/lightci/workspaces';
      const artifactsRoot = process.env.ARTIFACTS_ROOT || '/tmp/lightci/artifacts';

      // If pipeline exists in filesystem, delete its workspace
      if (pipeline?.workspaceId) {
        const workspacePath = path.join(workspacesRoot, pipeline.workspaceId);
        if (fs.existsSync(workspacePath)) {
          await fs.promises.rm(workspacePath, { recursive: true, force: true });
          console.log(`[Engine] Deleted workspace directory for pipeline ${id}`);
        }
      }

      // Delete any associated artifacts
      const artifactsPath = path.join(artifactsRoot, id);
      if (fs.existsSync(artifactsPath)) {
        await fs.promises.rm(artifactsPath, { recursive: true, force: true });
        console.log(`[Engine] Deleted artifacts for pipeline ${id}`);
      }

      console.log(`[Engine] Successfully cleaned up filesystem resources for pipeline ${id}`);
    } catch (error) {
      console.error(`[Engine] Error cleaning up filesystem resources for pipeline ${id}:`, error);
      // Don't throw the error - we want to proceed with database deletion even if filesystem cleanup fails
      // This handles the case where files might have been manually deleted
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
    // TODO: Implement filesystem-based build retrieval
    return null;
  }

  async updateBuild(id: string, updates: Partial<Build>): Promise<Build> {
    // TODO: Implement filesystem-based build update
    throw new Error('Not implemented');
  }

  async deleteBuild(id: string): Promise<void> {
    // TODO: Implement filesystem-based build deletion
  }

  async getBuildLogs(buildId: string): Promise<BuildLog[]> {
    // TODO: Implement filesystem-based build log retrieval
    return [];
  }

  async createArtifact(options: ArtifactCreateOptions): Promise<Artifact> {
    // TODO: Implement filesystem-based artifact creation
    throw new Error('Not implemented');
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    // TODO: Implement filesystem-based artifact retrieval
    return null;
  }

  async listArtifacts(buildId: string): Promise<Artifact[]> {
    // TODO: Implement filesystem-based artifact listing
    return [];
  }
}
