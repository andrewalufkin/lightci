import { jest, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { testServer } from './utils/testServer';
import { setupTestDb, cleanupTestDb } from './utils/testDb';

// Set test environment
process.env.NODE_ENV = 'test';

beforeAll(async () => {
  await setupTestDb();
  await testServer.start();
});

afterAll(async () => {
  await cleanupTestDb();
  await testServer.stop();
});

beforeEach(async () => {
  await testServer.reset();
});

afterEach(async () => {
  jest.clearAllMocks();
});
