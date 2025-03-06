import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// Use test database URL in test environment
const databaseUrl = process.env.NODE_ENV === 'test' 
  ? process.env.TEST_DATABASE_URL || 'postgresql://andrewadams@localhost:5432/lightci_test'
  : process.env.DATABASE_URL;

const prisma = global.prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  datasources: {
    db: {
      url: databaseUrl
    }
  }
});

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

export { prisma }; 