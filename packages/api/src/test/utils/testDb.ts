import { execSync } from 'child_process';
import { prisma } from '../../lib/prisma.js';

export async function setupTestDb() {
  try {
    // Ensure we're disconnected before setup
    await prisma.$disconnect();
    
    // Push the schema to the test database
    execSync('npx prisma db push --skip-generate', {
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgresql://andrewadams@localhost:5432/lightci_test'
      },
      stdio: 'inherit'
    });

    // Verify database connection
    await prisma.$connect();
    const result = await prisma.$queryRaw`SELECT current_database()`;
    console.log('Connected to database:', result);
    
  } catch (error) {
    console.error('Error setting up test database:', error);
    throw error;
  }
}

export async function clearTestDb() {
  try {
    // Delete all records from all tables in the correct order
    await prisma.$transaction([
      prisma.artifact.deleteMany(),        // Delete artifacts first since they reference pipeline runs
      prisma.usageRecord.deleteMany(),     // Delete usage records since they can reference pipeline runs
      prisma.pipelineRun.deleteMany(),     // Now safe to delete pipeline runs
      prisma.pipeline.deleteMany(),        // Then delete pipelines
      prisma.apiKey.deleteMany(),          // Then API keys
      prisma.user.deleteMany()             // Finally users
    ]);

    // Verify all tables are empty
    const tables = ['artifact', 'usageRecord', 'pipelineRun', 'pipeline', 'apiKey', 'user'] as const;
    for (const table of tables) {
      const count = await (prisma[table] as any).count();
      if (count > 0) {
        console.warn(`Warning: ${table} table not empty after cleanup (${count} records remain)`);
      }
    }
  } catch (error) {
    console.error('Error clearing test database:', error);
    throw error;
  }
}

export async function closeTestDb() {
  try {
    console.log('Closing test database connection...');
    await prisma.$disconnect();
    console.log('Test database connection closed successfully');
  } catch (error) {
    console.error('Error closing test database connection:', error);
  }
}

export { prisma as testDb }; 