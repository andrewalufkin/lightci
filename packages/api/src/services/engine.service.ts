import { Pipeline, PipelineConfig } from '../models/Pipeline';
import { Build, BuildConfig } from '../models/Build';
import { PaginatedResult } from '../models/types';
import { NotFoundError } from '../utils/errors';
import { BuildLog } from '../models/BuildLog';
import { Artifact } from '../models/Artifact';
import { credentials, Metadata, ServiceError, ClientUnaryCall, ClientWritableStream } from '@grpc/grpc-js';
import { promisify } from 'util';
import { 
  EngineServiceClient,
  Pipeline as GrpcPipeline,
  Build as GrpcBuild,
  Artifact as GrpcArtifact,
  PipelineStatus,
  BuildStatus,
  StepStatus,
  ListBuildsRequest,
  ListBuildsResponse,
  UploadArtifactRequest,
} from '../proto/proto/engine';

// Remove the circular dependency
// import { broadcastBuildUpdate } from '../routes/builds';

// Add an event emitter for build updates
import { EventEmitter } from 'events';
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
  private client: EngineServiceClient;

  constructor(coreUrl: string) {
    console.log('Initializing gRPC client with URL:', coreUrl);
    this.client = new EngineServiceClient(coreUrl, credentials.createInsecure(), {
      'grpc.keepalive_time_ms': 10000,
      'grpc.keepalive_timeout_ms': 5000,
      'grpc.http2.min_time_between_pings_ms': 10000,
      'grpc.keepalive_permit_without_calls': 1,
    });
  }

  private bindGrpcMethod<TRequest, TResponse>(
    method: (
      request: TRequest,
      callback: (error: ServiceError | null, response: TResponse) => void
    ) => ClientUnaryCall
  ): (request: TRequest) => Promise<TResponse> {
    return (request: TRequest): Promise<TResponse> => {
      return new Promise((resolve, reject) => {
        method.call(this.client, request, (error: ServiceError | null, response: TResponse) => {
          if (error) {
            console.error('gRPC call error:', error);
            reject(error);
          } else {
            resolve(response);
          }
        });
      });
    };
  }

  private toGrpcPipeline(pipeline: Pipeline): GrpcPipeline {
    return {
      id: pipeline.id,
      name: pipeline.name,
      repository: pipeline.repository,
      workspaceId: pipeline.workspaceId,
      description: pipeline.description || '',
      defaultBranch: pipeline.defaultBranch,
      status: PipelineStatus[`PIPELINE_STATUS_${pipeline.status.toUpperCase()}`],
      steps: pipeline.steps.map(step => ({
        id: step.id,
        name: step.name,
        command: step.command,
        timeoutSeconds: 0, // Default timeout
        environment: step.environment || {},
        dependencies: [], // No dependencies by default
      })),
      createdAt: pipeline.createdAt.toISOString(),
      updatedAt: pipeline.updatedAt.toISOString(),
    };
  }

  private fromGrpcPipeline(pipeline: GrpcPipeline): Pipeline {
    return {
      id: pipeline.id,
      name: pipeline.name,
      repository: pipeline.repository,
      workspaceId: pipeline.workspaceId,
      description: pipeline.description || undefined,
      defaultBranch: pipeline.defaultBranch,
      status: PipelineStatus[pipeline.status].toLowerCase().replace('pipeline_status_', '') as Pipeline['status'],
      steps: pipeline.steps.map(step => ({
        id: step.id,
        name: step.name,
        command: step.command,
        status: StepStatus[step.status].toLowerCase().replace('step_status_', '') as Step['status'],
        environment: step.environment || {},
      })),
      createdAt: new Date(pipeline.createdAt),
      updatedAt: new Date(pipeline.updatedAt),
    };
  }

  private fromGrpcBuild(build: GrpcBuild): Build {
    return {
      id: build.id,
      pipelineId: build.pipelineId,
      status: BuildStatus[build.status].toLowerCase().replace('build_status_', '') as Build['status'],
      branch: build.branch,
      commit: build.commit,
      parameters: build.parameters || {},
      startedAt: build.startedAt ? new Date(build.startedAt) : undefined,
      completedAt: build.completedAt ? new Date(build.completedAt) : undefined,
      createdAt: new Date(), // This should come from the server
      updatedAt: new Date(), // This should come from the server
      steps: [], // This should come from the server
    };
  }

  private fromGrpcArtifact(artifact: GrpcArtifact): Artifact {
    return {
      id: artifact.id,
      buildId: artifact.buildId,
      name: artifact.name,
      path: artifact.path,
      size: Number(artifact.size),
      contentType: artifact.contentType || undefined,
      metadata: artifact.metadata || {},
      createdAt: new Date(), // This should come from the server
    };
  }

  async listPipelines(options: PaginationOptions): Promise<PaginatedResult<Pipeline>> {
    const response = await promisify(this.client.listPipelines.bind(this.client))({
      page: options.page,
      limit: options.limit,
      filter: options.filter || '',
      sort: options.sort || '',
    });

    return {
      items: response.items.map(this.fromGrpcPipeline),
      total: response.total,
      page: response.page,
      limit: response.limit,
    };
  }

  async createPipeline(config: PipelineConfig & { workspaceId: string }): Promise<Pipeline> {
    const response = await promisify(this.client.createPipeline.bind(this.client))({
      name: config.name || '',
      repository: config.repository || '',
      workspaceId: config.workspaceId || '',
      description: config.description || '',
      defaultBranch: config.defaultBranch || 'main',
      steps: (config.steps || []).map(step => ({
        name: step.name || '',
        command: step.command || '',
        timeoutSeconds: step.timeout || 0,
        environment: step.environment || {},
        dependencies: step.dependencies || [],
      })),
    });

    return this.fromGrpcPipeline(response);
  }

  async getPipeline(id: string): Promise<Pipeline | null> {
    try {
      const response = await promisify(this.client.getPipeline.bind(this.client))({
        id,
      });
      return this.fromGrpcPipeline(response);
    } catch (error) {
      if (error.code === 5) { // NOT_FOUND
        return null;
      }
      throw error;
    }
  }

  async updatePipeline(id: string, config: PipelineConfig): Promise<Pipeline> {
    const response = await promisify(this.client.updatePipeline.bind(this.client))({
      id,
      name: config.name,
      repository: config.repository,
      description: config.description || '',
      defaultBranch: config.defaultBranch || 'main',
      steps: config.steps.map(step => ({
        id: step.id,
        name: step.name,
        command: step.command,
        timeoutSeconds: step.timeout || 0,
        environment: step.environment || {},
        dependencies: step.dependencies || [],
      })),
    });

    return this.fromGrpcPipeline(response);
  }

  async deletePipeline(id: string): Promise<void> {
    await promisify(this.client.deletePipeline.bind(this.client))({
      id,
    });
  }

  async listBuilds(options: PaginationOptions): Promise<PaginatedResult<Build>> {
    try {
      console.log('Calling gRPC listBuilds with options:', options);
      const listBuildsMethod = this.bindGrpcMethod<ListBuildsRequest, ListBuildsResponse>(this.client.listBuilds);
      const response = await listBuildsMethod({
        page: options.page,
        limit: options.limit,
        pipelineId: options.pipelineId || '',
        filter: options.filter || '',
        sort: options.sort || '',
      });
      console.log('Got gRPC response:', response);

      return {
        items: response.items.map(item => this.fromGrpcBuild(item)),
        total: response.total,
        page: response.page,
        limit: response.limit,
      };
    } catch (error) {
      console.error('gRPC listBuilds error:', error);
      throw error;
    }
  }

  async getBuild(id: string): Promise<Build | null> {
    try {
      const response = await promisify(this.client.getBuild.bind(this.client))({
        id,
      });
      return this.fromGrpcBuild(response);
    } catch (error) {
      if (error.code === 5) { // NOT_FOUND
        return null;
      }
      throw error;
    }
  }

  async getLatestBuilds(pipelineId: string, limit: number): Promise<Build[]> {
    const builds = await this.listBuilds({
      page: 1,
      limit,
      pipelineId,
    });
    return builds.items;
  }

  async triggerBuild(pipelineId: string, config: BuildConfig): Promise<Build> {
    const response = await promisify(this.client.triggerBuild.bind(this.client))({
      pipelineId,
      branch: config.branch,
      commit: config.commit,
      parameters: config.parameters,
    });

    return this.fromGrpcBuild(response);
  }

  async cancelBuild(id: string): Promise<void> {
    await promisify(this.client.cancelBuild.bind(this.client))({
      id,
    });
  }

  async getBuildLogs(id: string): Promise<BuildLog[]> {
    const response = await promisify(this.client.getBuildLogs.bind(this.client))({
      buildId: id,
    });

    return response.logs.map(log => ({
      stepId: log.stepId,
      content: log.content,
      timestamp: new Date(log.timestamp),
    }));
  }

  async getBuildArtifacts(id: string): Promise<Artifact[]> {
    const response = await promisify(this.client.listArtifacts.bind(this.client))({
      buildId: id,
    });

    return response.items.map(this.fromGrpcArtifact);
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    try {
      const response = await promisify(this.client.downloadArtifact.bind(this.client))({
        id,
      });
      return this.fromGrpcArtifact(response);
    } catch (error) {
      if (error.code === 5) { // NOT_FOUND
        return null;
      }
      throw error;
    }
  }

  async createArtifact(options: ArtifactCreateOptions): Promise<Artifact> {
    const metadata = new Metadata();
    metadata.set('build-id', options.buildId);
    metadata.set('name', options.name);
    if (options.contentType) {
      metadata.set('content-type', options.contentType);
    }
    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        metadata.set(`metadata-${key}`, value);
      }
    }

    const call = this.client.uploadArtifact(metadata);
    
    // First message contains metadata
    await new Promise<void>((resolve, reject) => {
      call.write({
        metadata: {
          buildId: options.buildId,
          name: options.name,
          contentType: options.contentType,
          metadata: options.metadata,
        },
      }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    // TODO: Implement actual file upload in chunks
    
    const response = await new Promise<GrpcArtifact>((resolve, reject) => {
      call.end((error) => {
        if (error) reject(error);
      });
      
      call.on('data', (response: GrpcArtifact) => {
        resolve(response);
      });
      
      call.on('error', (error) => {
        reject(error);
      });
    });

    return this.fromGrpcArtifact(response);
  }

  async deleteArtifact(id: string): Promise<void> {
    // TODO: Implement artifact deletion
  }

  async uploadArtifact(options: ArtifactCreateOptions, data: Buffer): Promise<Artifact> {
    return new Promise((resolve, reject) => {
      const callback = (error: ServiceError | null, response: GrpcArtifact) => {
        if (error) {
          console.error('Failed to upload artifact:', error);
          reject(error);
        } else {
          resolve(this.fromGrpcArtifact(response));
        }
      };

      const metadata = new Metadata();
      const stream = this.client.uploadArtifact(metadata, {}, callback);

      try {
        // Send metadata first
        stream.write({
          metadata: {
            buildId: options.buildId,
            name: options.name,
            contentType: options.contentType || '',
            metadata: options.metadata || {},
          },
        });

        // Send the file data
        stream.write({
          chunk: data,
        });

        stream.end();
      } catch (error) {
        console.error('Error writing to stream:', error);
        reject(error);
      }
    });
  }
}
