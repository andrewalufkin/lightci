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
    
    // Clean up any scheduled tasks
    try {
      // Get access to global objects that might have timers
      const globalTimers = global as any;
      
      // Clear any remaining timeouts
      if (globalTimers._timeoutIds && globalTimers._timeoutIds.size) {
        console.log(`Clearing ${globalTimers._timeoutIds.size} timeouts`);
        for (const id of globalTimers._timeoutIds) {
          clearTimeout(id);
        }
      }
      
      // Clear any remaining intervals
      if (globalTimers._intervalIds && globalTimers._intervalIds.size) {
        console.log(`Clearing ${globalTimers._intervalIds.size} intervals`);
        for (const id of globalTimers._intervalIds) {
          clearInterval(id);
        }
      }
      
      // Clear any remaining immediate callbacks
      if (globalTimers._immediateIds && globalTimers._immediateIds.size) {
        console.log(`Clearing ${globalTimers._immediateIds.size} immediate callbacks`);
        for (const id of globalTimers._immediateIds) {
          clearImmediate(id);
        }
      }
      
      // Force cleanup of any node-cron tasks
      try {
        // Try to access the internal scheduler
        const cron = require('node-cron');
        if (cron && typeof cron.getTasks === 'function') {
          const tasks = cron.getTasks();
          if (tasks) {
            console.log(`Stopping ${Object.keys(tasks).length} cron tasks`);
            for (const [key, task] of Object.entries(tasks)) {
              if (task && typeof (task as any).stop === 'function') {
                (task as any).stop();
              }
            }
          }
        }
      } catch (error) {
        // Ignore errors, as we might be in ESM mode
      }
    } catch (error) {
      console.error('Error cleaning up timers:', error);
    }
    
    // Add a shorter delay to ensure all cleanup is complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Force close any remaining connections with a shorter timeout
    let forceExitTimeout: NodeJS.Timeout | null = null;
    await new Promise<void>(resolve => {
      forceExitTimeout = setTimeout(() => {
        console.warn('Warning: Had to force close test suite due to hanging connections');
        
        // Force exit the process if we're still hanging
        if (process.env.FORCE_EXIT_TESTS === 'true') {
          console.warn('Forcing process exit to prevent hanging tests');
          process.exit(0);
        }
        
        resolve();
      }, 2000);

      // Clear the timeout if we resolve naturally
      process.on('beforeExit', () => {
        if (forceExitTimeout) {
          clearTimeout(forceExitTimeout);
          forceExitTimeout = null;
        }
        resolve();
      });
    });
    
    // Remove all listeners to prevent memory leaks
    process.removeAllListeners();
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }
  } catch (error) {
    console.error('Error during test cleanup:', error);
    throw error;
  }
}); 