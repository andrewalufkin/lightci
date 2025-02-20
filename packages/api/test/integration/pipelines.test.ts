import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { testServer } from '../utils/testServer';
import { mockEngineService, mockWorkspaceService, createMockPipeline, createMockBuild } from '../utils/mockServices';
import { Pipeline } from '../../src/models/Pipeline';
import { Build } from '../../src/models/Build';
import { PaginatedResult } from '../../src/models/types';

const app = testServer.getApp();
const validApiKey = 'test-api-key';

const mockPipelineConfig = {
  name: 'Test Pipeline',
  repository: 'https://github.com/test/repo',
  steps: [
    {
      name: 'Install Dependencies',
      command: 'npm install'
    },
    {
      name: 'Run Tests',
      command: 'npm test'
    }
  ]
};

describe('Pipeline Endpoints', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
  });

  describe('GET /api/pipelines', () => {
    test('should return list of pipelines with pagination', async () => {
      const mockPipelines: PaginatedResult<Pipeline> = {
        items: [createMockPipeline(), createMockPipeline()],
        total: 2,
        page: 1,
        limit: 20
      };

      mockEngineService.listPipelines.mockResolvedValue(mockPipelines);

      const response = await request(app)
        .get('/api/pipelines')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.pagination).toEqual({
        total: 2,
        page: 1,
        limit: 20
      });
    });

    test('should return 401 without API key', async () => {
      const response = await request(app)
        .get('/api/pipelines');

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/pipelines', () => {
    test('should create new pipeline', async () => {
      const mockWorkspace = {
        id: 'test-workspace-id',
        name: mockPipelineConfig.name,
        repository: mockPipelineConfig.repository,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const mockPipeline = createMockPipeline({
        name: mockPipelineConfig.name,
        repository: mockPipelineConfig.repository,
        workspaceId: mockWorkspace.id
      });

      mockWorkspaceService.createWorkspace.mockResolvedValue(mockWorkspace);
      mockEngineService.createPipeline.mockResolvedValue(mockPipeline);

      const response = await request(app)
        .post('/api/pipelines')
        .set('x-api-key', validApiKey)
        .send(mockPipelineConfig);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        name: mockPipeline.name,
        repository: mockPipeline.repository,
        status: mockPipeline.status,
        defaultBranch: mockPipeline.defaultBranch,
        workspaceId: mockPipeline.workspaceId
      });
      expect(response.body.id).toBeDefined();
      expect(response.body.createdAt).toBeDefined();
      expect(response.body.updatedAt).toBeDefined();
      expect(mockWorkspaceService.createWorkspace).toHaveBeenCalledWith({
        name: mockPipelineConfig.name,
        repository: mockPipelineConfig.repository
      });
    });

    test('should return 400 for invalid pipeline config', async () => {
      const invalidConfig = {
        name: 'Test Pipeline',
        repository: 'invalid-url',
        steps: []
      };

      const response = await request(app)
        .post('/api/pipelines')
        .set('x-api-key', validApiKey)
        .send(invalidConfig);

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/pipelines/:id', () => {
    test('should return pipeline with latest builds', async () => {
      const mockPipeline = createMockPipeline();
      const mockBuilds = [createMockBuild(), createMockBuild()];

      mockEngineService.getPipeline.mockResolvedValue(mockPipeline);
      mockEngineService.getLatestBuilds.mockResolvedValue(mockBuilds);

      const response = await request(app)
        .get(`/api/pipelines/${mockPipeline.id}`)
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: mockPipeline.id,
        name: mockPipeline.name,
        status: mockPipeline.status,
        repository: mockPipeline.repository,
        defaultBranch: mockPipeline.defaultBranch,
        steps: mockPipeline.steps,
        workspaceId: mockPipeline.workspaceId,
        latestBuilds: expect.any(Array)
      });
      expect(new Date(response.body.createdAt)).toBeInstanceOf(Date);
      expect(new Date(response.body.updatedAt)).toBeInstanceOf(Date);
      expect(response.body.latestBuilds).toHaveLength(mockBuilds.length);
    });

    test('should return 404 for non-existent pipeline', async () => {
      mockEngineService.getPipeline.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/pipelines/non-existent')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(404);
    });
  });

  describe('PUT /api/pipelines/:id', () => {
    test('should update existing pipeline', async () => {
      const mockPipeline = createMockPipeline();
      const updatedConfig = {
        ...mockPipelineConfig,
        name: 'Updated Pipeline'
      };

      mockEngineService.getPipeline.mockResolvedValue(mockPipeline);
      mockEngineService.updatePipeline.mockResolvedValue({
        ...mockPipeline,
        name: updatedConfig.name
      });

      const response = await request(app)
        .put(`/api/pipelines/${mockPipeline.id}`)
        .set('x-api-key', validApiKey)
        .send(updatedConfig);

      expect(response.status).toBe(200);
      expect(response.body.name).toBe(updatedConfig.name);
    });

    test('should return 404 for non-existent pipeline', async () => {
      mockEngineService.getPipeline.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/pipelines/non-existent')
        .set('x-api-key', validApiKey)
        .send(mockPipelineConfig);

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/pipelines/:id', () => {
    test('should delete pipeline and workspace', async () => {
      const mockPipeline = createMockPipeline();

      mockEngineService.getPipeline.mockResolvedValue(mockPipeline);
      mockEngineService.deletePipeline.mockResolvedValue(undefined);
      mockWorkspaceService.deleteWorkspace.mockResolvedValue(undefined);

      const response = await request(app)
        .delete(`/api/pipelines/${mockPipeline.id}`)
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(204);
      expect(mockEngineService.deletePipeline).toHaveBeenCalledWith(mockPipeline.id);
      expect(mockWorkspaceService.deleteWorkspace).toHaveBeenCalledWith(mockPipeline.workspaceId);
    });

    test('should return 404 for non-existent pipeline', async () => {
      mockEngineService.getPipeline.mockResolvedValue(null);

      const response = await request(app)
        .delete('/api/pipelines/non-existent')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/pipelines/:id/trigger', () => {
    test('should trigger pipeline build', async () => {
      const mockPipeline = createMockPipeline();
      const mockBuild = createMockBuild({
        pipelineId: mockPipeline.id,
        queuePosition: 1
      });

      mockEngineService.getPipeline.mockResolvedValue(mockPipeline);
      mockEngineService.triggerBuild.mockResolvedValue(mockBuild);

      const response = await request(app)
        .post(`/api/pipelines/${mockPipeline.id}/trigger`)
        .set('x-api-key', validApiKey)
        .send({
          branch: 'feature/test',
          commit: 'abc123'
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        buildId: expect.any(String),
        status: 'pending',
        queuePosition: 1
      });
    });

    test('should use default branch if not specified', async () => {
      const mockPipeline = createMockPipeline();
      const mockBuild = createMockBuild({
        pipelineId: mockPipeline.id,
        branch: mockPipeline.defaultBranch
      });

      mockEngineService.getPipeline.mockResolvedValue(mockPipeline);
      mockEngineService.triggerBuild.mockResolvedValue(mockBuild);

      const response = await request(app)
        .post(`/api/pipelines/${mockPipeline.id}/trigger`)
        .set('x-api-key', validApiKey)
        .send({});

      expect(response.status).toBe(200);
      expect(mockEngineService.triggerBuild).toHaveBeenCalledWith(
        mockPipeline.id,
        expect.objectContaining({
          branch: mockPipeline.defaultBranch
        })
      );
    });
  });
});
