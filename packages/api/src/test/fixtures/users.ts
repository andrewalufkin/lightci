import { User } from '@prisma/client';
import { testDb } from '../utils/testDb';
import bcrypt from 'bcrypt';

export const testUser = {
  email: 'test@example.com',
  username: 'testuser',
  passwordHash: '',  // Will be set before creation
  fullName: 'Test User'
};

export async function createTestUser(userData = testUser): Promise<User> {
  const passwordHash = await bcrypt.hash('Password123!', 10);
  
  return testDb.user.create({
    data: {
      email: userData.email,
      username: userData.username,
      passwordHash,
      fullName: userData.fullName
    }
  });
}

export async function createTestApiKey(userId: string) {
  const keyPrefix = 'test';
  const keyHash = await bcrypt.hash('test-api-key-' + Date.now(), 10);
  
  return testDb.apiKey.create({
    data: {
      userId,
      keyName: 'Test API Key',
      keyPrefix,
      keyHash,
      isActive: true
    }
  });
} 