import { prisma } from '../lib/prisma';

export class UserService {
  async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        accountStatus: true,
        accountTier: true
      }
    });
  }

  async findByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        accountStatus: true,
        accountTier: true,
        passwordHash: true
      }
    });
  }

  /**
   * Calculate a user's current artifact storage usage by analyzing their UsageRecords
   * @param userId The ID of the user
   * @returns An object containing storage usage information
   */
  async calculateArtifactStorageUsage(userId: string) {
    // Get all artifact storage usage records for this user using raw SQL
    const storageRecords = await prisma.$queryRaw`
      SELECT * FROM usage_records 
      WHERE user_id = ${userId} 
      AND usage_type = 'artifact_storage'
      ORDER BY timestamp ASC
    ` as Array<{ quantity: string | number }>;

    // Calculate current storage by summing all storage changes
    // Positive values are additions, negative values are deletions
    let currentStorageMB = 0;
    
    for (const record of storageRecords) {
      currentStorageMB += typeof record.quantity === 'string' 
        ? parseFloat(record.quantity) 
        : record.quantity;
    }

    // Convert to more readable formats
    const currentStorageGB = currentStorageMB / 1024;
    
    // Get the most recent artifacts
    const recentArtifacts = await prisma.artifact.findMany({
      where: {
        build: {
          pipeline: {
            OR: [
              { createdById: userId },
              { project: { userOwners: { some: { user_id: userId } } } }
            ]
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 10,
      include: {
        build: {
          select: {
            id: true,
            pipelineId: true,
            pipeline: {
              select: {
                name: true
              }
            }
          }
        }
      }
    });

    // Update the user's storage fields using raw SQL to avoid type issues
    const storageBytes = Math.round(currentStorageMB * 1024 * 1024); // Convert MB to bytes
    
    await prisma.$executeRaw`
      UPDATE "users" 
      SET artifact_storage_used = ${storageBytes}
      WHERE id = ${userId}
    `;
    
    // Also update the usage_history using raw SQL
    await prisma.$executeRaw`
      UPDATE "users" 
      SET usage_history = jsonb_set(
        COALESCE(usage_history, '{}'::jsonb),
        '{current_artifact_storage_mb}',
        to_jsonb(${currentStorageMB})
      )
      WHERE id = ${userId}
    `;
    
    await prisma.$executeRaw`
      UPDATE "users" 
      SET usage_history = jsonb_set(
        usage_history,
        '{last_storage_calculation}',
        to_jsonb(${new Date().toISOString()})
      )
      WHERE id = ${userId}
    `;

    return {
      currentStorageMB,
      currentStorageGB,
      artifactCount: recentArtifacts.length,
      recentArtifacts: recentArtifacts.map(artifact => ({
        id: artifact.id,
        name: artifact.name,
        size: artifact.size,
        sizeInMB: artifact.size / (1024 * 1024),
        pipelineName: artifact.build.pipeline.name,
        createdAt: artifact.createdAt
      }))
    };
  }
}

export const userService = new UserService(); 