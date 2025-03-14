import { PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { BillingService } from './billing.service.js';

/**
 * Service for handling pre-flight checks before pipeline runs
 */
export class PipelinePreflightService {

  constructor(
    private prismaClient: PrismaClient = prisma,
    private billingService: BillingService = new BillingService(prismaClient)
  ) {}

  /**
   * Perform pre-flight checks before running a pipeline
   * @param pipelineId The ID of the pipeline to check
   * @returns An object containing the check results
   */
  async performChecks(pipelineId: string): Promise<{ 
    canRun: boolean; 
    errors: string[]; 
    warnings: string[];
    pipeline: any;
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Get pipeline details with creator information
    const pipeline = await this.prismaClient.pipeline.findUnique({
      where: { id: pipelineId },
      include: {
        createdBy: true
      }
    });

    if (!pipeline) {
      errors.push('Pipeline not found');
      return { canRun: false, errors, warnings, pipeline: null };
    }

    // Check if the pipeline has a creator
    if (!pipeline.createdById) {
      errors.push('Pipeline has no associated user');
      return { canRun: false, errors, warnings, pipeline };
    }

    // Check storage limits
    try {
      const storageCheck = await this.billingService.checkStorageLimit(pipeline.createdById);
      
      if (!storageCheck.hasEnoughStorage) {
        errors.push(
          `Storage limit exceeded. Current usage is ${storageCheck.currentUsageMB.toFixed(2)} MB ` +
          `out of ${storageCheck.limitMB} MB allowed for your ${pipeline.createdBy?.accountTier || 'current'} plan. ` +
          `Please upgrade your plan or remove some artifacts to continue.`
        );
      } else if (storageCheck.remainingMB < 100) { // Less than 100MB remaining
        warnings.push(
          `Storage space is running low. Only ${storageCheck.remainingMB.toFixed(2)} MB remaining ` +
          `out of ${storageCheck.limitMB} MB allowed for your ${pipeline.createdBy?.accountTier || 'current'} plan. ` +
          `Consider upgrading your plan or removing old artifacts.`
        );
      }
    } catch (error) {
      console.error('[PipelinePreflightService] Error checking storage limit:', error);
      warnings.push('Could not verify storage limits. Proceeding with caution.');
    }

    // Add more pre-flight checks here as needed
    // For example: check build minutes quota, check concurrent builds limit, etc.

    return {
      canRun: errors.length === 0,
      errors,
      warnings,
      pipeline
    };
  }
} 