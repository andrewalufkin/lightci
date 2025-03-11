import app from '../app.js';
import { testUser, createTestUser } from './fixtures/users.js';
import { testDb } from './utils/testDb.js';
import { createRequest } from './utils/supertest.js';

describe('Pipeline Run Endpoints', () => {
  let authToken: string;
  let userId: string;
  let pipelineId: string;
  let expressApp: any;
  let request: any;

  beforeAll(async () => {
    request = await createRequest();
    expressApp = await app;
  });

  beforeEach(async () => {
    const user = await createTestUser();
    userId = user.id;
    const response = await request(expressApp)
      .post('/api/auth/login')
      .send({
        email: testUser.email,
        password: 'Password123!'
      });
    authToken = response.body.token;

    // Create a test pipeline
    const pipeline = await testDb.pipeline.create({
      data: {
        name: 'Test Pipeline',
        repository: 'https://github.com/user/repo',
        defaultBranch: 'main',
        steps: [
          {
            name: 'Build',
            command: 'npm run build'
          }
        ],
        createdById: userId
      }
    });
    pipelineId = pipeline.id;
  });

  describe('GET /api/pipeline-runs', () => {
    beforeEach(async () => {
      // Create test pipeline runs
      await testDb.pipelineRun.createMany({
        data: [
          {
            pipelineId,
            status: 'completed',
            branch: 'main',
            commit: '123abc',
            startedAt: new Date(),
            completedAt: new Date(),
            stepResults: [],
            logs: []
          },
          {
            pipelineId,
            status: 'failed',
            branch: 'feature',
            commit: '456def',
            startedAt: new Date(),
            completedAt: new Date(),
            stepResults: [],
            logs: [],
            error: 'Build failed'
          }
        ]
      });
    });

    it('should list all pipeline runs', async () => {
      const response = await request(expressApp)
        .get('/api/pipeline-runs')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0]).toHaveProperty('id');
      expect(response.body.data[0]).toHaveProperty('status');
      expect(response.body.data[0]).toHaveProperty('pipelineId');
    });

    it('should filter by pipeline id', async () => {
      const response = await request(expressApp)
        .get(`/api/pipeline-runs?pipelineId=${pipelineId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.every((run: { pipelineId: string }) => run.pipelineId === pipelineId)).toBe(true);
    });

    it('should filter by status', async () => {
      const response = await request(expressApp)
        .get('/api/pipeline-runs?status=completed')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.every((run: { status: string }) => run.status === 'completed')).toBe(true);
    });

    it('should require authentication', async () => {
      const response = await request(expressApp)
        .get('/api/pipeline-runs');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/pipeline-runs/:id', () => {
    let runId: string;

    beforeEach(async () => {
      const run = await testDb.pipelineRun.create({
        data: {
          pipelineId,
          status: 'completed',
          branch: 'main',
          commit: '123abc',
          startedAt: new Date(),
          completedAt: new Date(),
          stepResults: [
            {
              name: 'Build',
              status: 'success',
              duration: 1000,
              output: 'Build successful'
            }
          ],
          logs: ['Starting build...', 'Build completed']
        }
      });
      runId = run.id;
    });

    it('should get pipeline run by id', async () => {
      const response = await request(expressApp)
        .get(`/api/pipeline-runs/${runId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', runId);
      expect(response.body).toHaveProperty('status', 'completed');
      expect(response.body).toHaveProperty('stepResults');
      expect(response.body).toHaveProperty('logs');
    });

    it('should return 404 for non-existent run', async () => {
      const response = await request(expressApp)
        .get('/api/pipeline-runs/non-existent-id')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await request(expressApp)
        .get(`/api/pipeline-runs/${runId}`);

      expect(response.status).toBe(401);
    });
  });

  describe('PUT /api/pipeline-runs/:id/status', () => {
    let runId: string;

    beforeEach(async () => {
      const run = await testDb.pipelineRun.create({
        data: {
          pipelineId,
          status: 'pending',
          branch: 'main',
          commit: '123abc',
          startedAt: new Date(),
          stepResults: [],
          logs: []
        }
      });
      runId = run.id;
    });

    it('should update run status', async () => {
      const response = await request(expressApp)
        .put(`/api/pipeline-runs/${runId}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          status: 'running',
          stepResults: [
            {
              name: 'Build',
              status: 'running',
              output: 'Building...'
            }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('running');
      expect(response.body.stepResults).toHaveLength(1);
      expect(response.body.stepResults[0].status).toBe('running');

      // Verify update in database
      const run = await testDb.pipelineRun.findUnique({
        where: { id: runId }
      });
      expect(run?.status).toBe('running');
    });

    it('should validate status transitions', async () => {
      // Try to transition from pending directly to completed
      const response = await request(expressApp)
        .put(`/api/pipeline-runs/${runId}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          status: 'completed'
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should require authentication', async () => {
      const response = await request(expressApp)
        .put(`/api/pipeline-runs/${runId}/status`)
        .send({
          status: 'running'
        });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/pipeline-runs/:id/artifacts', () => {
    let runId: string;

    beforeEach(async () => {
      const run = await testDb.pipelineRun.create({
        data: {
          pipelineId,
          status: 'completed',
          branch: 'main',
          commit: '123abc',
          startedAt: new Date(),
          completedAt: new Date(),
          stepResults: [],
          logs: [],
          artifactsCollected: true,
          artifactsCount: 2,
          artifactsPath: '/artifacts/123',
          artifactsSize: 1024
        }
      });
      runId = run.id;
    });

    it('should list artifacts for a run', async () => {
      const response = await request(expressApp)
        .get(`/api/pipeline-runs/${runId}/artifacts`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('artifacts');
      expect(response.body).toHaveProperty('count');
      expect(response.body).toHaveProperty('size');
      expect(response.body).toHaveProperty('path');
    });

    it('should handle run with no artifacts', async () => {
      const emptyRun = await testDb.pipelineRun.create({
        data: {
          pipelineId,
          status: 'completed',
          branch: 'main',
          commit: '789ghi',
          startedAt: new Date(),
          completedAt: new Date(),
          stepResults: [],
          logs: [],
          artifactsCollected: false
        }
      });

      const response = await request(expressApp)
        .get(`/api/pipeline-runs/${emptyRun.id}/artifacts`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.artifacts).toHaveLength(0);
      expect(response.body.count).toBe(0);
    });

    it('should require authentication', async () => {
      const response = await request(expressApp)
        .get(`/api/pipeline-runs/${runId}/artifacts`);

      expect(response.status).toBe(401);
    });
  });
}); 