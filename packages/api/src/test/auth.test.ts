import request from 'supertest';
import app from './mocks/app';
import { testUser, createTestUser } from './fixtures/users';
import { testDb, clearTestDb } from './utils/testDb';
import * as bcrypt from 'bcrypt';

describe('Authentication Endpoints', () => {
  beforeEach(async () => {
    await clearTestDb();
  });

  describe('POST /api/auth/register', () => {
    it('should register a new user with valid data', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          email: testUser.email,
          username: testUser.username,
          password: 'Password123!',
          fullName: testUser.fullName
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body.email).toBe(testUser.email);
      expect(response.body.username).toBe(testUser.username);
      expect(response.body).not.toHaveProperty('passwordHash');

      // Verify user was created in database
      const user = await testDb.user.findUnique({
        where: { email: testUser.email }
      });
      expect(user).toBeTruthy();
      expect(user?.email).toBe(testUser.email);
    });

    it('should reject registration with existing email', async () => {
      await createTestUser();

      const response = await request(app)
        .post('/api/auth/register')
        .send({
          email: testUser.email,
          username: 'different',
          password: 'Password123!',
          fullName: 'Different Name'
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject registration with weak password', async () => {
      const response = await request(app)
        .post('/api/auth/register')
        .send({
          email: testUser.email,
          username: testUser.username,
          password: 'weak',
          fullName: testUser.fullName
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await createTestUser();
    });

    it('should login successfully with valid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: testUser.email,
          password: 'Password123!'
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('user');
      expect(response.body.user.email).toBe(testUser.email);
      expect(response.body.user).not.toHaveProperty('passwordHash');
    });

    it('should reject login with invalid password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: testUser.email,
          password: 'wrong-password'
        });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject login with non-existent email', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: 'Password123!'
        });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('POST /api/auth/api-keys', () => {
    let authToken: string;

    beforeEach(async () => {
      const user = await createTestUser();
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: testUser.email,
          password: 'Password123!'
        });
      authToken = response.body.token;
    });

    it('should create a new API key', async () => {
      const response = await request(app)
        .post('/api/auth/api-keys')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          name: 'Test Key'
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('key');
      expect(response.body.keyName).toBe('Test Key');
      expect(response.body.isActive).toBe(true);

      // Verify key exists in database
      const apiKey = await testDb.apiKey.findUnique({
        where: { id: response.body.id }
      });
      expect(apiKey).toBeTruthy();
      expect(apiKey?.keyName).toBe('Test Key');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/auth/api-keys')
        .send({
          name: 'Test Key'
        });

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/auth/api-keys', () => {
    let authToken: string;
    let userId: string;

    beforeEach(async () => {
      const user = await createTestUser();
      userId = user.id;
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: testUser.email,
          password: 'Password123!'
        });
      authToken = response.body.token;

      // Create some API keys
      await testDb.apiKey.createMany({
        data: [
          {
            userId,
            keyName: 'Key 1',
            keyPrefix: 'test1',
            keyHash: await bcrypt.hash('test-key-1', 10),
            isActive: true
          },
          {
            userId,
            keyName: 'Key 2',
            keyPrefix: 'test2',
            keyHash: await bcrypt.hash('test-key-2', 10),
            isActive: true
          }
        ]
      });
    });

    it('should list all API keys for the user', async () => {
      const response = await request(app)
        .get('/api/auth/api-keys')
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      expect(response.body[0]).toHaveProperty('id');
      expect(response.body[0]).toHaveProperty('keyName');
      expect(response.body[0]).not.toHaveProperty('keyHash');
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .get('/api/auth/api-keys');

      expect(response.status).toBe(401);
    });
  });

  describe('DELETE /api/auth/api-keys/:keyId', () => {
    let authToken: string;
    let userId: string;
    let apiKeyId: string;

    beforeEach(async () => {
      const user = await createTestUser();
      userId = user.id;
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          email: testUser.email,
          password: 'Password123!'
        });
      authToken = loginResponse.body.token;

      // Create an API key to delete
      const apiKey = await testDb.apiKey.create({
        data: {
          userId,
          keyName: 'Key to Delete',
          keyPrefix: 'test',
          keyHash: await bcrypt.hash('test-key', 10),
          isActive: true
        }
      });
      apiKeyId = apiKey.id;
    });

    it('should delete an API key', async () => {
      const response = await request(app)
        .delete(`/api/auth/api-keys/${apiKeyId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(204);

      // Verify key was deleted
      const apiKey = await testDb.apiKey.findUnique({
        where: { id: apiKeyId }
      });
      expect(apiKey).toBeNull();
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .delete(`/api/auth/api-keys/${apiKeyId}`);

      expect(response.status).toBe(401);
    });

    it('should not allow deleting another user\'s API key', async () => {
      // Create another user and their API key
      const otherUser = await createTestUser({
        email: 'other@example.com',
        username: 'otheruser',
        passwordHash: '',
        fullName: 'Other User'
      });

      const otherApiKey = await testDb.apiKey.create({
        data: {
          userId: otherUser.id,
          keyName: 'Other User Key',
          keyPrefix: 'other',
          keyHash: await bcrypt.hash('other-key', 10),
          isActive: true
        }
      });

      const response = await request(app)
        .delete(`/api/auth/api-keys/${otherApiKey.id}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(403);

      // Verify key still exists
      const apiKey = await testDb.apiKey.findUnique({
        where: { id: otherApiKey.id }
      });
      expect(apiKey).toBeTruthy();
    });
  });
}); 