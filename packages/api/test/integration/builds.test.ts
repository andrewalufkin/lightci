import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { testServer } from '../utils/testServer';
import { mockEngineService, createMockBuild } from '../utils/mockServices';
import { Build } from '../../src/models/Build';
import { PaginatedResult } from '../../src/models/types';

const app = testServer.getApp();
const validApiKey = 'test-api-key';

describe('Build Endpoints', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
  });

  describe('GET /api/builds', () => {
    test('should return list of builds with pagination', async () => {
      const mockBuilds: PaginatedResult<Build> = {
        items: [createMockBuild(), createMockBuild()],
        total: 2,
        page: 1,
        limit: 20
      };

      mockEngineService.listBuilds.mockResolvedValue(mockBuilds);

      const response = await request(app)
        .get('/api/builds')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.pagination).toEqual({
        total: 2,
        page: 1,
        limit: 20
      });
    });

    test('should filter builds by pipeline ID', async () => {
      const pipelineId = 'test-pipeline-id';
      const mockBuilds: PaginatedResult<Build> = {
        items: [createMockBuild({ pipelineId })],
        total: 1,
        page: 1,
        limit: 20
      };

      mockEngineService.listBuilds.mockResolvedValue(mockBuilds);

      const response = await request(app)
        .get('/api/builds')
        .query({ pipelineId })
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].pipelineId).toBe(pipelineId);
    });

    test('should return 401 without API key', async () => {
      const response = await request(app)
        .get('/api/builds');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/builds/:id', () => {
    test('should return build details', async () => {
      const mockBuild = createMockBuild();

      mockEngineService.getBuild.mockResolvedValue(mockBuild);

      const response = await request(app)
        .get(`/api/builds/${mockBuild.id}`)
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: mockBuild.id,
        pipelineId: mockBuild.pipelineId,
        status: mockBuild.status,
        branch: mockBuild.branch,
        commit: mockBuild.commit,
        steps: mockBuild.steps
      });
      expect(new Date(response.body.createdAt)).toBeInstanceOf(Date);
      expect(new Date(response.body.updatedAt)).toBeInstanceOf(Date);
    });

    test('should return 404 for non-existent build', async () => {
      mockEngineService.getBuild.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/builds/non-existent')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/builds/:id/cancel', () => {
    test('should cancel running build', async () => {
      const mockBuild = createMockBuild({ status: 'running' });

      mockEngineService.getBuild.mockResolvedValue(mockBuild);
      mockEngineService.cancelBuild.mockResolvedValue(undefined);

      const response = await request(app)
        .post(`/api/builds/${mockBuild.id}/cancel`)
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(204);
      expect(mockEngineService.cancelBuild).toHaveBeenCalledWith(mockBuild.id);
    });

    test('should return 400 if build is not running', async () => {
      const mockBuild = createMockBuild({ status: 'completed' });

      mockEngineService.getBuild.mockResolvedValue(mockBuild);

      const response = await request(app)
        .post(`/api/builds/${mockBuild.id}/cancel`)
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(400);
      expect(mockEngineService.cancelBuild).not.toHaveBeenCalled();
    });

    test('should return 404 for non-existent build', async () => {
      mockEngineService.getBuild.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/builds/non-existent/cancel')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/builds/:id/logs', () => {
    test('should return build logs', async () => {
      const mockBuild = createMockBuild();
      const mockLogs = [
        { stepId: 'step-1', content: 'Installing dependencies...', timestamp: new Date() },
        { stepId: 'step-2', content: 'Running tests...', timestamp: new Date() }
      ];

      mockEngineService.getBuild.mockResolvedValue(mockBuild);
      mockEngineService.getBuildLogs.mockResolvedValue(mockLogs);

      const response = await request(app)
        .get(`/api/builds/${mockBuild.id}/logs`)
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(mockLogs.length);
      expect(response.body[0]).toMatchObject({
        stepId: mockLogs[0].stepId,
        content: mockLogs[0].content
      });
      expect(new Date(response.body[0].timestamp)).toBeInstanceOf(Date);
    });

    test('should return 404 for non-existent build', async () => {
      mockEngineService.getBuild.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/builds/non-existent/logs')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/builds/:id/artifacts', () => {
    test('should return build artifacts', async () => {
      const mockBuild = createMockBuild();
      const mockArtifacts = [
        {
          id: 'artifact-1',
          buildId: mockBuild.id,
          name: 'test-results.xml',
          path: '/artifacts/test-results.xml',
          size: 1024,
          createdAt: new Date()
        }
      ];

      mockEngineService.getBuild.mockResolvedValue(mockBuild);
      mockEngineService.getBuildArtifacts.mockResolvedValue(mockArtifacts);

      const response = await request(app)
        .get(`/api/builds/${mockBuild.id}/artifacts`)
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(mockArtifacts.length);
      expect(response.body[0]).toMatchObject({
        id: mockArtifacts[0].id,
        buildId: mockArtifacts[0].buildId,
        name: mockArtifacts[0].name,
        path: mockArtifacts[0].path,
        size: mockArtifacts[0].size
      });
      expect(new Date(response.body[0].createdAt)).toBeInstanceOf(Date);
    });

    test('should return 404 for non-existent build', async () => {
      mockEngineService.getBuild.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/builds/non-existent/artifacts')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(404);
    });
  });
});
