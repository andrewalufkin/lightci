import { setupTestDb, clearTestDb, closeTestDb } from './utils/testDb';

// Set test environment variables
process.env.DATABASE_URL = 'postgresql://andrewadams@localhost:5432/lightci_test';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.GITHUB_WEBHOOK_SECRET = 'your-webhook-secret';

beforeAll(async () => {
  try {
    // Set up test database
    await setupTestDb();
  } catch (error) {
    console.error('Error in test setup:', error);
    throw error;
  }
});

beforeEach(async () => {
  try {
    // Clear all tables before each test
    await clearTestDb();
  } catch (error) {
    console.error('Error clearing test database:', error);
    throw error;
  }
});

afterEach(async () => {
  try {
    // Clear data after each test
    await clearTestDb();
  } catch (error) {
    console.error('Error clearing test database:', error);
    throw error;
  }
});

afterAll(async () => {
  try {
    // Clean up database connection
    await clearTestDb();
    await closeTestDb();
    
    // Add a longer delay to ensure all cleanup is complete
    await new Promise(resolve => setTimeout(resolve, 1000));
  } catch (error) {
    console.error('Error during test cleanup:', error);
    throw error;
  }
}); 