import * as supertest from 'supertest';
import app from '../app';
import { testUser, createTestUser } from './fixtures/users';
import { testDb } from './utils/testDb';

describe('Pipeline Endpoints', () => {
  let authToken: string;
  let userId: string;

  beforeEach(async () => {
    const user = await createTestUser();
    userId = user.id;
    const response = await supertest(app)
      .post('/api/auth/login')
      .send({
        email: testUser.email,
        password: 'Password123!'
      });
    authToken = response.body.token;
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
      const response = await supertest(app)
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
      const response = await supertest(app)
        .post('/api/pipelines')
        .send(validPipeline);

      expect(response.status).toBe(401);
    });

    it('should validate required fields', async () => {
      const invalidPipeline = {
        name: 'Test Pipeline',
        // Missing required fields
      };

      const response = await supertest(app)
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
      const response = await supertest(app)
        .get('/api/pipelines')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toHaveProperty('id');
      expect(response.body[0]).toHaveProperty('name');
      expect(response.body[0].createdById).toBe(userId);
    });

    it('should support pagination', async () => {
      const response = await supertest(app)
        .get('/api/pipelines?page=1&limit=1')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.items)).toBe(true);
      expect(response.body.items).toHaveLength(1);
      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('page');
      expect(response.body).toHaveProperty('totalPages');
    });

    it('should require authentication', async () => {
      const response = await supertest(app)
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
      const response = await supertest(app)
        .get(`/api/pipelines/${pipelineId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id', pipelineId);
      expect(response.body.createdById).toBe(userId);
    });

    it('should return 404 for non-existent pipeline', async () => {
      const response = await supertest(app)
        .get('/api/pipelines/non-existent-id')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await supertest(app)
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

      const response = await supertest(app)
        .put(`/api/pipelines/${pipelineId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updates);

      expect(response.status).toBe(200);
      expect(response.body.name).toBe(updates.name);
      expect(response.body.description).toBe(updates.description);

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

      const response = await supertest(app)
        .put(`/api/pipelines/${otherPipeline.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Hacked Pipeline' });

      expect(response.status).toBe(403);

      // Verify pipeline was not updated
      const pipeline = await testDb.pipeline.findUnique({
        where: { id: otherPipeline.id }
      });
      expect(pipeline?.name).toBe('Other Pipeline');
    });

    it('should require authentication', async () => {
      const response = await supertest(app)
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
      const response = await supertest(app)
        .delete(`/api/pipelines/${pipelineId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);

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

      const response = await supertest(app)
        .delete(`/api/pipelines/${otherPipeline.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(403);

      // Verify pipeline still exists
      const pipeline = await testDb.pipeline.findUnique({
        where: { id: otherPipeline.id }
      });
      expect(pipeline).toBeTruthy();
    });

    it('should require authentication', async () => {
      const response = await supertest(app)
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
      const response = await supertest(app)
        .post(`/api/pipelines/${pipelineId}/trigger`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          branch: 'main',
          commit: '123abc'
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body.pipelineId).toBe(pipelineId);
      expect(response.body.status).toBe('pending');
      expect(response.body.branch).toBe('main');
      expect(response.body.commit).toBe('123abc');

      // Verify run was created in database
      const run = await testDb.pipelineRun.findUnique({
        where: { id: response.body.id }
      });
      expect(run).toBeTruthy();
      expect(run?.status).toBe('pending');
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

      const response = await supertest(app)
        .post(`/api/pipelines/${otherPipeline.id}/trigger`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          branch: 'main'
        });

      expect(response.status).toBe(403);
    });

    it('should require authentication', async () => {
      const response = await supertest(app)
        .post(`/api/pipelines/${pipelineId}/trigger`)
        .send({
          branch: 'main'
        });

      expect(response.status).toBe(401);
    });
  });
}); 