import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import * as crypto from 'crypto';

// Define a type for the User model with usage_history
interface UserWithUsageHistory {
  id: string;
  email: string;
  username?: string;
  passwordHash: string;
  fullName?: string;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
  accountStatus: string;
  accountTier: string;
  usage_history: Record<string, any>;
}

/**
 * Service for handling billing-related operations
 */
export class BillingService {
  constructor(
    private prismaClient: PrismaClient = prisma // Default to the global instance
  ) {}

  /**
   * Track build minutes for a completed pipeline run
   * @param runId The ID of the completed pipeline run
   * @param userId The ID of the user who owns the pipeline
   * @returns The created usage record
   */
  async trackBuildMinutes(runId: string, userId?: string): Promise<any> {
    try {
      // Use a transaction to ensure atomicity
      return await this.prismaClient.$transaction(async (tx: any) => {
        // Get the pipeline run details
        const pipelineRun = await tx.pipelineRun.findUnique({
          where: { id: runId },
          include: {
            pipeline: {
              select: {
                projectId: true,
                createdById: true
              }
            }
          }
        });

        if (!pipelineRun) {
          throw new Error(`Pipeline run not found`);
        }

        // Calculate build minutes based on start and completion time
        const startTime = pipelineRun.startedAt;
        const endTime = pipelineRun.completedAt || new Date();
        
        // Calculate duration in minutes (rounded up to the nearest minute)
        const durationMs = endTime.getTime() - startTime.getTime();
        const durationMinutes = Math.ceil(durationMs / (1000 * 60));

        // Determine the user ID (use provided userId, or fall back to the pipeline creator)
        const effectiveUserId = userId || pipelineRun.pipeline.createdById;

        if (!effectiveUserId) {
          throw new Error('No user ID available for billing');
        }

        // Create a usage record using the Prisma model
        const usageRecordId = crypto.randomUUID();
        
        // Create the usage record using the proper Prisma model
        const usageRecord = await tx.usageRecord.create({
          data: {
            id: usageRecordId,
            user_id: effectiveUserId,
            usage_type: 'build_minutes',
            quantity: durationMinutes,
            pipeline_run_id: runId,
            project_id: pipelineRun.pipeline.projectId || null, // Allow null project_id
            metadata: {
              pipelineRunStatus: pipelineRun.status,
              startTime: startTime.toISOString(),
              endTime: endTime.toISOString()
            },
            timestamp: new Date()
          }
        });

        // Update the user's usage history
        await this.updateUserUsageHistory(effectiveUserId, 'build_minutes', durationMinutes, tx);

        return { id: usageRecordId, quantity: durationMinutes };
      });
    } catch (error) {
      console.error('[BillingService] Error tracking build minutes:', error);
      // Wrap the error with a consistent format
      if (error instanceof Error) {
        throw new Error(`Error tracking build minutes: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Update a user's usage history with new usage data
   * @param userId The ID of the user
   * @param usageType The type of usage (e.g., 'build_minutes')
   * @param quantity The amount of usage to add
   * @param txClient Optional transaction client
   */
  private async updateUserUsageHistory(
    userId: string, 
    usageType: string, 
    quantity: number,
    txClient?: any
  ): Promise<void> {
    const client = txClient || this.prismaClient;
    
    try {
      // Get the current user
      const user = await client.user.findUnique({
        where: { id: userId }
      }) as UserWithUsageHistory;

      if (!user) {
        throw new Error(`User with ID ${userId} not found`);
      }

      // Parse the current usage history
      const usageHistory = user.usage_history;
      
      // Get the current date in YYYY-MM format for monthly tracking
      const currentMonth = new Date().toISOString().substring(0, 7);
      
      // Initialize the month if it doesn't exist
      if (!usageHistory[currentMonth]) {
        usageHistory[currentMonth] = {};
      }
      
      // Initialize the usage type if it doesn't exist
      if (!usageHistory[currentMonth][usageType]) {
        usageHistory[currentMonth][usageType] = 0;
      }
      
      // Add the new usage
      usageHistory[currentMonth][usageType] += quantity;
      
      // Update the user's usage history
      await client.user.update({
        where: { id: userId },
        data: { usage_history: usageHistory }
      });
    } catch (error) {
      console.error('[BillingService] Error updating user usage history:', error);
      throw error;
    }
  }

  /**
   * Get a user's billing usage information
   * @param userId The ID of the user
   * @returns The user's billing usage information
   */
  async getUserBillingUsage(userId: string): Promise<any> {
    try {
      // Get the user
      const user = await this.prismaClient.user.findUnique({
        where: { id: userId }
      }) as UserWithUsageHistory;

      if (!user) {
        throw new Error(`User with ID ${userId} not found`);
      }

      // Get the current month in YYYY-MM format
      const currentMonth = new Date().toISOString().substring(0, 7);

      // Calculate current artifact storage from usage records
      const storageRecords = await this.prismaClient.usageRecord.findMany({
        where: {
          user_id: userId,
          usage_type: "artifact_storage"
        },
        orderBy: {
          timestamp: 'desc'
        }
      });

      // Sum up all storage changes (additions and deletions)
      const currentStorageMB = storageRecords.reduce((total, record) => total + record.quantity, 0);
      const currentStorageGB = Math.max(0, currentStorageMB / 1024); // Convert MB to GB, ensure non-negative

      // Parse the usage history
      const usageHistory = user.usage_history;
      const currentMonthUsage = usageHistory[currentMonth] || {};
      
      return {
        currentMonth: {
          build_minutes: currentMonthUsage.build_minutes || 0,
          storage_gb: currentStorageGB
        }
      };
    } catch (error) {
      console.error('[BillingService] Error getting user billing usage:', error);
      throw new Error(`Error getting user billing usage: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Track artifact storage when a new artifact is created
   * @param artifactId The ID of the created artifact
   * @returns The created usage record
   */
  async trackArtifactStorage(artifactId: string): Promise<any> {
    try {
      // Use a transaction to ensure atomicity
      return await this.prismaClient.$transaction(async (tx: any) => {
        // Get the artifact details
        const artifact = await tx.artifact.findUnique({
          where: { id: artifactId },
          include: {
            build: {
              include: {
                pipeline: {
                  include: {
                    createdBy: true,
                    project: {
                      include: {
                        userOwners: true,
                        orgOwners: true,
                      }
                    }
                  }
                }
              }
            }
          }
        });

        if (!artifact) {
          throw new Error(`Artifact with ID ${artifactId} not found`);
        }

        // Determine the owner (user or organization)
        const pipelineRun = artifact.build;
        const pipeline = pipelineRun.pipeline;
        const project = pipeline.project;
        
        // Store size in megabytes for consistent usage tracking
        const sizeInMB = artifact.size / (1024 * 1024);
        
        // Create usage record
        const usageRecordId = crypto.randomUUID();
        const usageRecord = await tx.usageRecord.create({
          data: {
            id: usageRecordId,
            usage_type: "artifact_storage",
            quantity: sizeInMB,
            pipeline_run_id: pipelineRun.id,
            project_id: project?.id,
            user_id: pipeline.createdById || project?.userOwners[0]?.user_id,
            organization_id: project?.orgOwners[0]?.org_id,
            metadata: {
              artifact_id: artifact.id,
              artifact_name: artifact.name,
              storage_type: pipeline.artifactStorageType,
              action: "created"
            }
          }
        });

        // Update the user's usage history
        if (pipeline.createdById) {
          await this.updateUserUsageHistory(pipeline.createdById, 'storage_mb', sizeInMB, tx);
        }

        return { id: usageRecordId, quantity: sizeInMB };
      });
    } catch (error) {
      console.error('[BillingService] Error tracking artifact storage:', error);
      if (error instanceof Error) {
        throw new Error(`Error tracking artifact storage: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Track artifact storage reduction when an artifact is deleted
   * @param artifactId The ID of the deleted artifact
   * @param size The size of the deleted artifact
   * @returns The created usage record
   */
  async trackArtifactDeletion(artifactId: string, size: number): Promise<any> {
    try {
      // Use a transaction to ensure atomicity
      return await this.prismaClient.$transaction(async (tx: any) => {
        // Get the artifact owner info before deleting
        const artifact = await tx.artifact.findUnique({
          where: { id: artifactId },
          include: {
            build: {
              include: {
                pipeline: {
                  include: {
                    createdBy: true,
                    project: {
                      include: {
                        userOwners: true,
                        orgOwners: true,
                      }
                    }
                  }
                }
              }
            }
          }
        });

        if (!artifact) {
          throw new Error(`Artifact with ID ${artifactId} not found`);
        }

        const pipelineRun = artifact.build;
        const pipeline = pipelineRun.pipeline;
        const project = pipeline.project;
        
        // Store size in megabytes for consistent usage tracking
        const sizeInMB = size / (1024 * 1024);
        
        // Create negative usage record to offset the storage
        const usageRecordId = crypto.randomUUID();
        const usageRecord = await tx.usageRecord.create({
          data: {
            id: usageRecordId,
            usage_type: "artifact_storage",
            quantity: -sizeInMB, // Negative quantity to represent reduction
            pipeline_run_id: pipelineRun.id,
            project_id: project?.id,
            user_id: pipeline.createdById || project?.userOwners[0]?.user_id,
            organization_id: project?.orgOwners[0]?.org_id,
            metadata: {
              artifact_id: artifactId,
              storage_type: pipeline.artifactStorageType,
              action: "deleted"
            }
          }
        });

        // Update the user's usage history
        if (pipeline.createdById) {
          await this.updateUserUsageHistory(pipeline.createdById, 'storage_mb', -sizeInMB, tx);
        }

        return { id: usageRecordId, quantity: -sizeInMB };
      });
    } catch (error) {
      console.error('[BillingService] Error tracking artifact deletion:', error);
      if (error instanceof Error) {
        throw new Error(`Error tracking artifact deletion: ${error.message}`);
      }
      throw error;
    }
  }
} 