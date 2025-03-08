import request from 'supertest';
import app from './mocks/app';
import { testUser, createTestUser } from './fixtures/users';
import { testDb, clearTestDb } from './utils/testDb';
import * as bcrypt from 'bcrypt';

describe('Authentication Endpoints', () => {

  beforeAll(() => {
    // Ensure JWT_SECRET is set for tests
    process.env.JWT_SECRET = 'your-jwt-secret';
    console.log('Setting test JWT_SECRET:', process.env.JWT_SECRET);
  });

  beforeEach(async () => {
    await clearTestDb();
    // Log the JWT secret to ensure it's set correctly
    console.log('JWT Secret:', process.env.JWT_SECRET);
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
      // Log the response status and body for debugging
      console.log('Register Response Status:', response.status);
      console.log('Register Response Body:', response.body);

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('user');
      expect(response.body).toHaveProperty('token');
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
    let authToken: string;

    beforeEach(async () => {
      // Create a test user first
      const user = await createTestUser();
      
      // Try to login and get token
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: testUser.email,
          password: 'Password123!'
        });
      
      // Log response for debugging
      console.log('Login test - response status:', response.status);
      console.log('Login test - response body:', JSON.stringify(response.body));
      
      if (response.body && response.body.token) {
        authToken = response.body.token;
        console.log('Generated Auth Token:', authToken ? `${authToken.substring(0, 15)}...` : 'undefined');
      } else {
        console.error('Failed to get auth token in beforeEach!');
      }
    });
    
    it('should login successfully with valid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: testUser.email,
          password: 'Password123!'
        });
      // Log the response status and body for debugging
      console.log('Login Response Status:', response.status);
      console.log('Login Response Body:', response.body);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('token');
      expect(response.body).toHaveProperty('user');
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