import { jest } from '@jest/globals';
import { Pipeline, PipelineConfig } from '../../src/models/Pipeline';
import { Build, BuildConfig } from '../../src/models/Build';
import { PaginatedResult } from '../../src/models/types';
import { EngineService } from '../../src/services/engine.service';
import { WorkspaceService } from '../../src/services/workspace.service';
import { Workspace } from '../../src/models/Workspace';
import { BuildLog } from '../../src/models/BuildLog';
import { Artifact } from '../../src/models/Artifact';

// Mock EngineService implementation
export class MockEngineService extends EngineService {
  constructor() {
    super('http://mock-core-url');
  }

  listPipelines = jest.fn<() => Promise<PaginatedResult<Pipeline>>>();
  createPipeline = jest.fn<() => Promise<Pipeline>>();
  getPipeline = jest.fn<() => Promise<Pipeline | null>>();
  updatePipeline = jest.fn<() => Promise<Pipeline>>();
  deletePipeline = jest.fn<() => Promise<void>>();
  getLatestBuilds = jest.fn<() => Promise<Build[]>>();
  triggerBuild = jest.fn<() => Promise<Build>>();
  listBuilds = jest.fn<() => Promise<PaginatedResult<Build>>>();
  getBuild = jest.fn<() => Promise<Build | null>>();
  cancelBuild = jest.fn<() => Promise<void>>();
  getBuildLogs = jest.fn<() => Promise<BuildLog[]>>();
  getBuildArtifacts = jest.fn<() => Promise<Artifact[]>>();
  getArtifact = jest.fn<() => Promise<Artifact | null>>();
  createArtifact = jest.fn<() => Promise<Artifact>>();
  deleteArtifact = jest.fn<() => Promise<void>>();
}

// Mock WorkspaceService implementation
export class MockWorkspaceService extends WorkspaceService {
  createWorkspace = jest.fn<() => Promise<Workspace>>();
  getWorkspace = jest.fn<() => Promise<Workspace | null>>();
  deleteWorkspace = jest.fn<() => Promise<void>>();
}

// Create instances of mock services
export const mockEngineService = new MockEngineService();
export const mockWorkspaceService = new MockWorkspaceService();

export function createMockPipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: 'test-pipeline-id',
    name: 'Test Pipeline',
    status: 'pending',
    repository: 'https://github.com/test/repo',
    defaultBranch: 'main',
    steps: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    workspaceId: 'test-workspace-id',
    ...overrides
  };
}

export function createMockBuild(overrides: Partial<Build> = {}): Build {
  return {
    id: 'test-build-id',
    pipelineId: 'test-pipeline-id',
    status: 'pending',
    branch: 'main',
    commit: 'abc123',
    steps: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}
