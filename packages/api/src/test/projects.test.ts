import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import createTestApp from './utils/testApp';
import { testDb } from './utils/testDb';
import { generateJWT } from '../utils/auth.utils';

describe('Project Endpoints', () => {
  let app: any;
  let testUserId: string;
  let authToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    process.env.JWT_SECRET = 'test-secret';
  });

  beforeEach(async () => {
    // Create a test user and get auth token
    testUserId = uuidv4();
    const user = await testDb.user.create({
      data: {
        id: testUserId,
        email: `test-${uuidv4()}@example.com`,
        passwordHash: 'dummy_hash',
        fullName: 'Test User',
        accountStatus: 'active',
        accountTier: 'free'
      }
    });
    authToken = generateJWT(user);
  });

  afterEach(async () => {
    // Clean up all test data
    await testDb.userProject.deleteMany({});
    await testDb.project.deleteMany({});
    await testDb.user.deleteMany({});
  });

  describe('POST /api/projects', () => {
    it('should create a new project with valid data', async () => {
      const projectData = {
        name: 'Test Project',
        description: 'A test project',
        visibility: 'private',
        defaultBranch: 'main'
      };

      const response = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send(projectData);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        name: projectData.name,
        description: projectData.description,
        visibility: projectData.visibility
      });

      // Verify user ownership
      const userProject = await testDb.userProject.findFirst({
        where: {
          project_id: response.body.id,
          user_id: testUserId
        }
      });
      expect(userProject).toBeTruthy();
    });

    it('should return 400 when project name is missing', async () => {
      const response = await request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ description: 'Invalid project' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should return 401 when auth token is missing', async () => {
      const response = await request(app)
        .post('/api/projects')
        .send({ name: 'Test Project' });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/projects', () => {
    beforeEach(async () => {
      // Create some test projects
      const project1 = await testDb.project.create({
        data: {
          id: uuidv4(),
          name: 'Project 1',
          visibility: 'private',
          updated_at: new Date()
        }
      });

      await testDb.userProject.create({
        data: {
          user_id: testUserId,
          project_id: project1.id
        }
      });

      const project2 = await testDb.project.create({
        data: {
          id: uuidv4(),
          name: 'Project 2',
          visibility: 'public',
          updated_at: new Date()
        }
      });

      await testDb.userProject.create({
        data: {
          user_id: testUserId,
          project_id: project2.id
        }
      });
    });

    it('should list all projects for authenticated user', async () => {
      const response = await request(app)
        .get('/api/projects')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toHaveProperty('name');
      expect(response.body[0].userOwners).toBeDefined();
      expect(response.body[0].userOwners[0].user.id).toBe(testUserId);
    });

    it('should return 401 when auth token is missing', async () => {
      const response = await request(app)
        .get('/api/projects');

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/projects/:id', () => {
    let testProjectId: string;

    beforeEach(async () => {
      // Create a test project
      const project = await testDb.project.create({
        data: {
          id: uuidv4(),
          name: 'Test Project',
          visibility: 'private',
          updated_at: new Date()
        }
      });
      testProjectId = project.id;

      await testDb.userProject.create({
        data: {
          user_id: testUserId,
          project_id: project.id
        }
      });
    });

    it('should return project details for valid ID', async () => {
      const response = await request(app)
        .get(`/api/projects/${testProjectId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: testProjectId,
        name: 'Test Project'
      });
      expect(response.body.userOwners[0].user.id).toBe(testUserId);
    });

    it('should return 404 for non-existent project', async () => {
      const response = await request(app)
        .get(`/api/projects/${uuidv4()}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });

    it('should return 403 when accessing another user\'s private project', async () => {
      const otherUserId = uuidv4();
      
      // Create the other user first
      await testDb.user.create({
        data: {
          id: otherUserId,
          email: `other-${uuidv4()}@example.com`,
          passwordHash: 'dummy_hash',
          fullName: 'Other User',
          accountStatus: 'active',
          accountTier: 'free'
        }
      });

      const otherProject = await testDb.project.create({
        data: {
          id: uuidv4(),
          name: 'Other Project',
          visibility: 'private',
          updated_at: new Date()
        }
      });

      await testDb.userProject.create({
        data: {
          user_id: otherUserId,
          project_id: otherProject.id
        }
      });

      const response = await request(app)
        .get(`/api/projects/${otherProject.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(403);
    });
  });

  describe('PUT /api/projects/:id', () => {
    let testProjectId: string;

    beforeEach(async () => {
      // Create a test project
      const project = await testDb.project.create({
        data: {
          id: uuidv4(),
          name: 'Test Project',
          visibility: 'private',
          updated_at: new Date()
        }
      });
      testProjectId = project.id;

      await testDb.userProject.create({
        data: {
          user_id: testUserId,
          project_id: project.id
        }
      });
    });

    it('should update project with valid data', async () => {
      const updateData = {
        name: 'Updated Project',
        description: 'Updated description',
        visibility: 'public'
      };

      const response = await request(app)
        .put(`/api/projects/${testProjectId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send(updateData);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: testProjectId,
        name: updateData.name,
        description: updateData.description,
        visibility: updateData.visibility
      });
    });

    it('should return 403 when updating another user\'s project', async () => {
      const otherUserId = uuidv4();
      
      // Create the other user first
      await testDb.user.create({
        data: {
          id: otherUserId,
          email: `other-${uuidv4()}@example.com`,
          passwordHash: 'dummy_hash',
          fullName: 'Other User 2',
          accountStatus: 'active',
          accountTier: 'free'
        }
      });

      const otherProject = await testDb.project.create({
        data: {
          id: uuidv4(),
          name: 'Other Project',
          visibility: 'private',
          updated_at: new Date()
        }
      });

      await testDb.userProject.create({
        data: {
          user_id: otherUserId,
          project_id: otherProject.id
        }
      });

      const response = await request(app)
        .put(`/api/projects/${otherProject.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Updated Name' });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/projects/:id', () => {
    let testProjectId: string;

    beforeEach(async () => {
      // Create a test project
      const project = await testDb.project.create({
        data: {
          id: uuidv4(),
          name: 'Test Project',
          visibility: 'private',
          updated_at: new Date()
        }
      });
      testProjectId = project.id;

      await testDb.userProject.create({
        data: {
          user_id: testUserId,
          project_id: project.id
        }
      });
    });

    it('should delete project successfully', async () => {
      const response = await request(app)
        .delete(`/api/projects/${testProjectId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(204);

      // Verify project and relations are deleted
      const deletedProject = await testDb.project.findUnique({
        where: { id: testProjectId }
      });
      expect(deletedProject).toBeNull();

      const deletedUserProject = await testDb.userProject.findFirst({
        where: {
          project_id: testProjectId,
          user_id: testUserId
        }
      });
      expect(deletedUserProject).toBeNull();
    });

    it('should return 403 when deleting another user\'s project', async () => {
      const otherUserId = uuidv4();
      
      // Create the other user first
      await testDb.user.create({
        data: {
          id: otherUserId,
          email: `other-${uuidv4()}@example.com`,
          passwordHash: 'dummy_hash',
          fullName: 'Other User 3',
          accountStatus: 'active',
          accountTier: 'free'
        }
      });

      const otherProject = await testDb.project.create({
        data: {
          id: uuidv4(),
          name: 'Other Project',
          visibility: 'private',
          updated_at: new Date()
        }
      });

      await testDb.userProject.create({
        data: {
          user_id: otherUserId,
          project_id: otherProject.id
        }
      });

      const response = await request(app)
        .delete(`/api/projects/${otherProject.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(403);
    });

    it('should return 404 when deleting non-existent project', async () => {
      const response = await request(app)
        .delete(`/api/projects/${uuidv4()}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });
  });
}); 