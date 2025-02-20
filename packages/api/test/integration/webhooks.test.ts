import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import request from 'supertest';
import { testServer } from '../utils/testServer';
import { mockEngineService, createMockPipeline } from '../utils/mockServices';
import { Pipeline } from '../../src/models/Pipeline';
import { PaginatedResult } from '../../src/models/types';

const app = testServer.getApp();

describe('Webhook Endpoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/webhooks/github', () => {
    test('should handle GitHub push event', async () => {
      const mockPipeline = createMockPipeline({
        repository: 'https://github.com/test/repo'
      });

      mockEngineService.listPipelines.mockResolvedValue({
        items: [mockPipeline],
        total: 1,
        page: 1,
        limit: 1
      } as PaginatedResult<Pipeline>);

      const response = await request(app)
        .post('/api/webhooks/github')
        .set({
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': 'sha256=test',
          'X-GitHub-Delivery': 'test-delivery'
        })
        .send({
          ref: 'refs/heads/main',
          after: 'abc123',
          repository: {
            html_url: 'https://github.com/test/repo'
          }
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Build triggered successfully' });
      expect(mockEngineService.triggerBuild).toHaveBeenCalledWith(
        mockPipeline.id,
        {
          branch: 'main',
          commit: 'abc123'
        }
      );
    });

    test('should handle GitHub pull request event', async () => {
      const mockPipeline = createMockPipeline({
        repository: 'https://github.com/test/repo'
      });

      mockEngineService.listPipelines.mockResolvedValue({
        items: [mockPipeline],
        total: 1,
        page: 1,
        limit: 1
      } as PaginatedResult<Pipeline>);

      const response = await request(app)
        .post('/api/webhooks/github')
        .set({
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': 'sha256=test',
          'X-GitHub-Delivery': 'test-delivery'
        })
        .send({
          pull_request: {
            head: {
              ref: 'feature-branch',
              sha: 'def456'
            }
          },
          repository: {
            html_url: 'https://github.com/test/repo'
          }
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Build triggered successfully' });
      expect(mockEngineService.triggerBuild).toHaveBeenCalledWith(
        mockPipeline.id,
        {
          branch: 'feature-branch',
          commit: 'def456'
        }
      );
    });

    test('should return 400 for missing headers', async () => {
      const response = await request(app)
        .post('/api/webhooks/github')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    test('should return 404 for unknown repository', async () => {
      mockEngineService.listPipelines.mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 1
      } as PaginatedResult<Pipeline>);

      const response = await request(app)
        .post('/api/webhooks/github')
        .set({
          'X-GitHub-Event': 'push',
          'X-Hub-Signature-256': 'sha256=test',
          'X-GitHub-Delivery': 'test-delivery'
        })
        .send({
          ref: 'refs/heads/main',
          after: 'abc123',
          repository: {
            html_url: 'https://github.com/unknown/repo'
          }
        });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'No pipeline found for this repository' });
    });
  });

  describe('POST /api/webhooks/gitlab', () => {
    test('should handle GitLab push event', async () => {
      const mockPipeline = createMockPipeline({
        repository: 'https://gitlab.com/test/repo'
      });

      mockEngineService.listPipelines.mockResolvedValue({
        items: [mockPipeline],
        total: 1,
        page: 1,
        limit: 1
      } as PaginatedResult<Pipeline>);

      const response = await request(app)
        .post('/api/webhooks/gitlab')
        .set({
          'X-Gitlab-Event': 'Push Hook',
          'X-Gitlab-Token': 'test-token'
        })
        .send({
          ref: 'refs/heads/main',
          after: 'abc123',
          project: {
            web_url: 'https://gitlab.com/test/repo'
          }
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Build triggered successfully' });
      expect(mockEngineService.triggerBuild).toHaveBeenCalledWith(
        mockPipeline.id,
        {
          branch: 'main',
          commit: 'abc123'
        }
      );
    });

    test('should handle GitLab merge request event', async () => {
      const mockPipeline = createMockPipeline({
        repository: 'https://gitlab.com/test/repo'
      });

      mockEngineService.listPipelines.mockResolvedValue({
        items: [mockPipeline],
        total: 1,
        page: 1,
        limit: 1
      } as PaginatedResult<Pipeline>);

      const response = await request(app)
        .post('/api/webhooks/gitlab')
        .set({
          'X-Gitlab-Event': 'Merge Request Hook',
          'X-Gitlab-Token': 'test-token'
        })
        .send({
          object_attributes: {
            source_branch: 'feature-branch',
            last_commit: {
              id: 'def456'
            }
          },
          project: {
            web_url: 'https://gitlab.com/test/repo'
          }
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Build triggered successfully' });
      expect(mockEngineService.triggerBuild).toHaveBeenCalledWith(
        mockPipeline.id,
        {
          branch: 'feature-branch',
          commit: 'def456'
        }
      );
    });

    test('should return 400 for missing headers', async () => {
      const response = await request(app)
        .post('/api/webhooks/gitlab')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    test('should return 404 for unknown repository', async () => {
      mockEngineService.listPipelines.mockResolvedValue({
        items: [],
        total: 0,
        page: 1,
        limit: 1
      } as PaginatedResult<Pipeline>);

      const response = await request(app)
        .post('/api/webhooks/gitlab')
        .set({
          'X-Gitlab-Event': 'Push Hook',
          'X-Gitlab-Token': 'test-token'
        })
        .send({
          ref: 'refs/heads/main',
          after: 'abc123',
          project: {
            web_url: 'https://gitlab.com/unknown/repo'
          }
        });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'No pipeline found for this repository' });
    });
  });
});
