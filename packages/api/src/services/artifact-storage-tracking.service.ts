import { PrismaClient } from '@prisma/client';
import { v4 as uuid } from 'uuid';

export class ArtifactStorageTrackingService {
  constructor(private prisma: PrismaClient) {}

  async trackArtifactStorage(artifactId: string) {
    // Get the artifact details
    const artifact = await this.prisma.artifact.findUnique({
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
    await this.prisma.usage_records.create({
      data: {
        id: uuid(),
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
    
    // Update user/org usage summary
    if (pipeline.createdById) {
      await this.updateUserStorageUsage(pipeline.createdById);
    } else if (project?.orgOwners[0]?.org_id) {
      await this.updateOrgStorageUsage(project.orgOwners[0].org_id);
    }
  }

  async trackArtifactDeletion(artifactId: string, size: number) {
    // Get the artifact owner info before deleting
    const artifact = await this.prisma.artifact.findUnique({
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
    await this.prisma.usage_records.create({
      data: {
        id: uuid(),
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
    
    // Update the storage usage summary
    if (pipeline.createdById) {
      await this.updateUserStorageUsage(pipeline.createdById);
    } else if (project?.orgOwners[0]?.org_id) {
      await this.updateOrgStorageUsage(project.orgOwners[0].org_id);
    }
  }

  private async updateUserStorageUsage(userId: string) {
    // Get all active artifacts for this user
    const artifacts = await this.prisma.artifact.findMany({
      where: {
        build: {
          pipeline: {
            OR: [
              { createdById: userId },
              { project: { userOwners: { some: { user_id: userId } } } }
            ]
          }
        }
      }
    });
    
    // Calculate total storage (in MB)
    const totalStorageMB = artifacts.reduce(
      (sum, artifact) => sum + (artifact.size / (1024 * 1024)), 
      0
    );
    
    // Update user's usage_history
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        usage_history: {
          ...(await this.prisma.user.findUnique({ where: { id: userId } }))?.usage_history as any,
          current_artifact_storage_mb: totalStorageMB,
          last_storage_calculation: new Date().toISOString()
        }
      }
    });
  }

  private async updateOrgStorageUsage(orgId: string) {
    // Get all active artifacts for this organization
    const artifacts = await this.prisma.artifact.findMany({
      where: {
        build: {
          pipeline: {
            project: {
              orgOwners: {
                some: { org_id: orgId }
              }
            }
          }
        }
      }
    });
    
    // Calculate total storage (in MB)
    const totalStorageMB = artifacts.reduce(
      (sum, artifact) => sum + (artifact.size / (1024 * 1024)), 
      0
    );
    
    // Update organization's usage_history
    await this.prisma.organization.update({
      where: { id: orgId },
      data: {
        usage_history: {
          ...(await this.prisma.organization.findUnique({ where: { id: orgId } }))?.usage_history as any,
          current_artifact_storage_mb: totalStorageMB,
          last_storage_calculation: new Date().toISOString()
        }
      }
    });
  }

  async calculateStorageForBillingPeriod(billingPeriodId: string) {
    const billingPeriod = await this.prisma.billing_periods.findUnique({
      where: { id: billingPeriodId },
    });

    if (!billingPeriod) {
      throw new Error(`Billing period ${billingPeriodId} not found`);
    }

    // Determine the entity (user or organization)
    const entityId = billingPeriod.user_id || billingPeriod.organization_id;
    const isOrg = !!billingPeriod.organization_id;
    
    // Get storage usage records within this billing period
    const storageRecords = await this.prisma.usage_records.findMany({
      where: {
        usage_type: "artifact_storage",
        timestamp: {
          gte: billingPeriod.start_date,
          lte: billingPeriod.end_date,
        },
        ...(isOrg 
          ? { organization_id: entityId }
          : { user_id: entityId })
      },
      orderBy: {
        timestamp: 'asc',
      },
    });
    
    // Calculate total storage-days for the period
    let currentStorage = 0;
    let totalStorageMBDays = 0;
    let lastTimestamp = billingPeriod.start_date;
    
    for (const record of storageRecords) {
      // Add the storage-days for the period up to this record
      const days = (record.timestamp.getTime() - lastTimestamp.getTime()) / (1000 * 60 * 60 * 24);
      totalStorageMBDays += currentStorage * days;
      
      // Update the current storage and timestamp
      currentStorage += record.quantity;
      lastTimestamp = record.timestamp;
    }
    
    // Add the final period to the end of the billing period
    const finalDays = (billingPeriod.end_date.getTime() - lastTimestamp.getTime()) / (1000 * 60 * 60 * 24);
    totalStorageMBDays += currentStorage * finalDays;
    
    // Update the billing period with storage summary
    await this.prisma.billing_periods.update({
      where: { id: billingPeriodId },
      data: {
        usage_summary: {
          ...billingPeriod.usage_summary as any,
          artifact_storage: {
            mb_days: totalStorageMBDays,
            gb_months: totalStorageMBDays / 1024 / 30, // Convert to GB-months for billing
            average_storage_mb: totalStorageMBDays / ((billingPeriod.end_date.getTime() - billingPeriod.start_date.getTime()) / (1000 * 60 * 60 * 24))
          }
        }
      }
    });
  }
} 