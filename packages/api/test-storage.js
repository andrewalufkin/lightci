import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function test() {
  try {
    // Create a test user
    const user = await prisma.user.create({
      data: {
        email: 'test@example.com',
        passwordHash: 'test-hash',
        artifact_storage_used: 1024 // 1KB
      }
    });
    console.log('Created user:', user);

    // Create a usage record
    const usageRecord = await prisma.usageRecord.create({
      data: {
        id: 'test-record',
        usage_type: 'storage',
        quantity: 1.0,
        storage_change: 1024,
        user_id: user.id
      }
    });
    console.log('Created usage record:', usageRecord);

    // Verify the user's storage
    const verifyUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { artifact_storage_used: true }
    });
    console.log('Verified user storage:', verifyUser);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

test(); 