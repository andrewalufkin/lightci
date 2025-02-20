import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { testServer } from '../utils/testServer';
import { mockEngineService, createMockBuild } from '../utils/mockServices';
import { Artifact } from '../../src/models/Artifact';

const app = testServer.getApp();
const validApiKey = 'test-api-key';

describe('Artifact Endpoints', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
  });

  describe('GET /api/artifacts/:id', () => {
    test('should download artifact', async () => {
      const mockArtifact: Artifact = {
        id: 'test-artifact-id',
        buildId: 'test-build-id',
        name: 'test-results.xml',
        path: '/artifacts/test-results.xml',
        size: 1024,
        contentType: 'application/xml',
        createdAt: new Date()
      };

      mockEngineService.getArtifact.mockResolvedValue(mockArtifact);

      const response = await request(app)
        .get(`/api/artifacts/${mockArtifact.id}`)
        .set('x-api-key', validApiKey);

      const expectedContent = `Mock content for artifact ${mockArtifact.name}`;

      expect(response.status).toBe(200);
      expect(response.header['content-type']).toContain(mockArtifact.contentType);
      expect(response.header['content-disposition']).toBe(`attachment; filename="${mockArtifact.name}"`);
      expect(response.header['content-length']).toBe(expectedContent.length.toString());
      expect(response.text).toBe(expectedContent);
    });

    test('should return 404 for non-existent artifact', async () => {
      mockEngineService.getArtifact.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/artifacts/non-existent')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(404);
    });

    test('should return 401 without API key', async () => {
      const response = await request(app)
        .get('/api/artifacts/test-id');

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/artifacts', () => {
    test('should upload artifact', async () => {
      const mockBuild = createMockBuild();
      const artifactData = {
        buildId: mockBuild.id,
        name: 'test-results.xml',
        contentType: 'application/xml',
        size: 1024,
        metadata: {
          testsPassed: '42',
          testsFailed: '0'
        }
      };

      const mockArtifact: Artifact = {
        id: 'test-artifact-id',
        ...artifactData,
        path: `/artifacts/${mockBuild.id}/test-results.xml`,
        createdAt: new Date()
      };

      mockEngineService.getBuild.mockResolvedValue(mockBuild);
      mockEngineService.createArtifact.mockResolvedValue(mockArtifact);

      const response = await request(app)
        .post('/api/artifacts')
        .set('x-api-key', validApiKey)
        .send(artifactData);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        id: mockArtifact.id,
        buildId: mockArtifact.buildId,
        name: mockArtifact.name,
        path: mockArtifact.path,
        size: mockArtifact.size,
        contentType: mockArtifact.contentType,
        metadata: mockArtifact.metadata
      });
      expect(new Date(response.body.createdAt)).toBeInstanceOf(Date);
    });

    test('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/artifacts')
        .set('x-api-key', validApiKey)
        .send({
          contentType: 'application/xml'
        });

      expect(response.status).toBe(400);
    });

    test('should return 404 for non-existent build', async () => {
      mockEngineService.getBuild.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/artifacts')
        .set('x-api-key', validApiKey)
        .send({
          buildId: 'non-existent',
          name: 'test.xml'
        });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /api/artifacts/:id', () => {
    test('should delete artifact', async () => {
      const mockArtifact: Artifact = {
        id: 'test-artifact-id',
        buildId: 'test-build-id',
        name: 'test-results.xml',
        path: '/artifacts/test-results.xml',
        size: 1024,
        createdAt: new Date()
      };

      mockEngineService.getArtifact.mockResolvedValue(mockArtifact);
      mockEngineService.deleteArtifact.mockResolvedValue(undefined);

      const response = await request(app)
        .delete(`/api/artifacts/${mockArtifact.id}`)
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(204);
      expect(mockEngineService.deleteArtifact).toHaveBeenCalledWith(mockArtifact.id);
    });

    test('should return 404 for non-existent artifact', async () => {
      mockEngineService.getArtifact.mockResolvedValue(null);

      const response = await request(app)
        .delete('/api/artifacts/non-existent')
        .set('x-api-key', validApiKey);

      expect(response.status).toBe(404);
    });
  });
});
