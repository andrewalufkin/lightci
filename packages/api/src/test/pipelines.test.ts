import { default as appPromise, cleanupForTests } from '../app.js';
import { testUser, createTestUser } from './fixtures/users.js';
import { testDb, closeTestDb, setupTestDb, clearTestDb } from './utils/testDb.js';
import { generateJWT } from '../utils/auth.utils.js';
import { SchedulerService } from '../services/scheduler.service.js';
import { PipelineRunnerService } from '../services/pipeline-runner.service.js';
import { WorkspaceService } from '../services/workspace.service.js';
import request from 'supertest';

describe('Pipeline Endpoints', () => {
  let authToken: string;
  let userId: string;
  let testRequest: any;
  let schedulerService: SchedulerService;
  let pipelineRunnerService: PipelineRunnerService;
  let user: any;
  let server: any;

  beforeAll(async () => {
    // Set up test database
    await setupTestDb();
    
    process.env.NODE_ENV = 'test';
    // Initialize app and start server
    const app = await appPromise;
    server = app.listen();
    testRequest = request(server);
    
    // Initialize services
    const workspaceService = new WorkspaceService();
    pipelineRunnerService = new PipelineRunnerService(workspaceService);
    schedulerService = new SchedulerService(pipelineRunnerService);
  });

  beforeEach(async () => {
    // Clear database and create fresh test user before each test
    await clearTestDb();
    user = await createTestUser();
    userId = user.id;
    authToken = generateJWT(user);
  });

  afterAll(async () => {
    // Clean up in reverse order of creation
    if (schedulerService) {
      schedulerService.stopAll();
    }
    
    if (pipelineRunnerService) {
      await pipelineRunnerService.cleanup();
    }

    await cleanupForTests();
    await closeTestDb();
    
    // Close the server
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('POST /api/pipelines', () => {
    const validPipeline = {
      name: 'Test Pipeline',
      description: 'Test pipeline description',
      repository: 'https://github.com/user/repo',
      defaultBranch: 'main',
      steps: [
        {
          name: 'Build',
          command: 'npm run build'
        }
      ]
    };

    it('should create a pipeline with valid data', async () => {
      const response = await testRequest
        .post('/api/pipelines')
        .set('Authorization', `Bearer ${authToken}`)
        .send(validPipeline);

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body.name).toBe(validPipeline.name);
      expect(response.body.repository).toBe(validPipeline.repository);
      expect(response.body.createdById).toBe(userId);

      // Verify pipeline was created in database
      const pipeline = await testDb.pipeline.findUnique({
        where: { id: response.body.id }
      });
      expect(pipeline).toBeTruthy();
      expect(pipeline?.name).toBe(validPipeline.name);
    });

    it('should require authentication', async () => {
      const response = await testRequest
        .post('/api/pipelines')
        .send(validPipeline);

      expect(response.status).toBe(401);
    });

    it('should validate required fields', async () => {
      const invalidPipeline = {
        name: 'Test Pipeline',
        // Missing required fields
      };

      const response = await testRequest
        .post('/api/pipelines')
        .set('Authorization', `Bearer ${authToken}`)
        .send(invalidPipeline);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/pipelines', () => {
    beforeEach(async () => {
      // Create test pipelines
      await testDb.pipeline.createMany({
        data: [
          {
            name: 'Pipeline 1',
            repository: 'https://github.com/user/repo1',
            defaultBranch: 'main',
            steps: [],
            createdById: userId
          },
          {
            name: 'Pipeline 2',
            repository: 'https://github.com/user/repo2',
            defaultBranch: 'main',
            steps: [],
            createdById: userId
          }
        ]
      });
    });

    it('should list all pipelines for the user', async () => {
      const response = await testRequest
        .get('/api/pipelines')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.data[0]).toHaveProperty('id');
      expect(response.body.data[0]).toHaveProperty('name');
      expect(response.body.data[0].createdById).toBe(userId);
    });

    it('should support pagination', async () => {
      const response = await testRequest
        .get('/api/pipelines?page=1&limit=1')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body).toHaveProperty('pagination');
      expect(response.body.pagination).toHaveProperty('total');
      expect(response.body.pagination).toHaveProperty('page');
      expect(response.body.pagination).toHaveProperty('limit');
    });

    it('should require authentication', async () => {
      const response = await testRequest
        .get('/api/pipelines');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/pipelines/:id', () => {
    let pipelineId: string;

    beforeEach(async () => {
      const pipeline = await testDb.pipeline.create({
        data: {
          name: 'Test Pipeline',
          repository: 'https://github.com/user/repo',
          defaultBranch: 'main',
          steps: [],
          createdById: userId
        }
      });
      pipelineId = pipeline.id;
    });

    it('should get pipeline by id', async () => {
      const response = await testRequest
        .get(`/api/pipelines/${pipelineId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('id', pipelineId);
      expect(response.body.data.createdById).toBe(userId);
    });

    it('should return 404 for non-existent pipeline', async () => {
      const response = await testRequest
        .get('/api/pipelines/non-existent-id')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await testRequest
        .get(`/api/pipelines/${pipelineId}`);

      expect(response.status).toBe(401);
    });
  });

  describe('PUT /api/pipelines/:id', () => {
    let pipelineId: string;

    beforeEach(async () => {
      const pipeline = await testDb.pipeline.create({
        data: {
          name: 'Test Pipeline',
          repository: 'https://github.com/user/repo',
          defaultBranch: 'main',
          steps: [],
          createdById: userId
        }
      });
      pipelineId = pipeline.id;
    });

    it('should update pipeline', async () => {
      const updates = {
        name: 'Updated Pipeline',
        description: 'Updated description'
      };

      const response = await testRequest
        .put(`/api/pipelines/${pipelineId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updates);

      expect(response.status).toBe(200);
      expect(response.body.data.name).toBe(updates.name);
      expect(response.body.data.description).toBe(updates.description);

      // Verify updates in database
      const pipeline = await testDb.pipeline.findUnique({
        where: { id: pipelineId }
      });
      expect(pipeline?.name).toBe(updates.name);
      expect(pipeline?.description).toBe(updates.description);
    });

    it('should not allow updating another user\'s pipeline', async () => {
      // Create another user and their pipeline
      const otherUser = await createTestUser({
        email: 'other@example.com',
        username: 'otheruser',
        passwordHash: '',
        fullName: 'Other User'
      });

      const otherPipeline = await testDb.pipeline.create({
        data: {
          name: 'Other Pipeline',
          repository: 'https://github.com/other/repo',
          defaultBranch: 'main',
          steps: [],
          createdById: otherUser.id
        }
      });

      const response = await testRequest
        .put(`/api/pipelines/${otherPipeline.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Hacked Pipeline' });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Pipeline not found or access denied');

      // Verify pipeline was not updated
      const pipeline = await testDb.pipeline.findUnique({
        where: { id: otherPipeline.id }
      });
      expect(pipeline?.name).toBe('Other Pipeline');
    });

    it('should require authentication', async () => {
      const response = await testRequest
        .put(`/api/pipelines/${pipelineId}`)
        .send({ name: 'Updated Pipeline' });

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/pipelines/:id', () => {
    let pipelineId: string;

    beforeEach(async () => {
      const pipeline = await testDb.pipeline.create({
        data: {
          name: 'Test Pipeline',
          repository: 'https://github.com/user/repo',
          defaultBranch: 'main',
          steps: [],
          createdById: userId
        }
      });
      pipelineId = pipeline.id;
    });

    it('should delete pipeline', async () => {
      const response = await testRequest
        .delete(`/api/pipelines/${pipelineId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(204);

      // Verify pipeline was deleted
      const pipeline = await testDb.pipeline.findUnique({
        where: { id: pipelineId }
      });
      expect(pipeline).toBeNull();
    });

    it('should not allow deleting another user\'s pipeline', async () => {
      // Create another user and their pipeline
      const otherUser = await createTestUser({
        email: 'other@example.com',
        username: 'otheruser',
        passwordHash: '',
        fullName: 'Other User'
      });

      const otherPipeline = await testDb.pipeline.create({
        data: {
          name: 'Other Pipeline',
          repository: 'https://github.com/other/repo',
          defaultBranch: 'main',
          steps: [],
          createdById: otherUser.id
        }
      });

      const response = await testRequest
        .delete(`/api/pipelines/${otherPipeline.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Pipeline not found or access denied');

      // Verify pipeline still exists
      const pipeline = await testDb.pipeline.findUnique({
        where: { id: otherPipeline.id }
      });
      expect(pipeline).toBeTruthy();
    });

    it('should require authentication', async () => {
      const response = await testRequest
        .delete(`/api/pipelines/${pipelineId}`);

      expect(response.status).toBe(401);
    });
  });

  describe('POST /api/pipelines/:id/trigger', () => {
    let pipelineId: string;

    beforeEach(async () => {
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

    it('should trigger pipeline run', async () => {
      const response = await testRequest
        .post(`/api/pipelines/${pipelineId}/trigger`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          branch: 'main',
          commit: '123abc'
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('message', 'Pipeline triggered successfully');
      expect(response.body).toHaveProperty('runId');
      expect(response.body).toHaveProperty('status', 'running');

      // Verify run was created in database
      const run = await testDb.pipelineRun.findUnique({
        where: { id: response.body.runId }
      });
      expect(run).toBeTruthy();
      expect(run?.status).toBe('running');
    });

    it('should not allow triggering another user\'s pipeline', async () => {
      // Create another user and their pipeline
      const otherUser = await createTestUser({
        email: 'other@example.com',
        username: 'otheruser',
        passwordHash: '',
        fullName: 'Other User'
      });

      const otherPipeline = await testDb.pipeline.create({
        data: {
          name: 'Other Pipeline',
          repository: 'https://github.com/other/repo',
          defaultBranch: 'main',
          steps: [],
          createdById: otherUser.id
        }
      });

      const response = await testRequest
        .post(`/api/pipelines/${otherPipeline.id}/trigger`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          branch: 'main'
        });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error', 'Pipeline not found or access denied');
    });

    it('should require authentication', async () => {
      const response = await testRequest
        .post(`/api/pipelines/${pipelineId}/trigger`)
        .send({
          branch: 'main'
        });

      expect(response.status).toBe(401);
    });
  });
}); 