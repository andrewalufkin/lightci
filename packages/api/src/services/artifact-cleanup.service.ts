import { PrismaClient } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as cron from 'node-cron';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

// Store the scheduled task so we can stop it later
let scheduledCleanupTask: cron.ScheduledTask | null = null;

export class ArtifactCleanupService {
  private artifactsBasePath: string;

  constructor() {
    this.artifactsBasePath = process.env.ARTIFACTS_PATH || path.join(process.cwd(), 'artifacts');
  }

  private async ensureArtifactsDirectory(): Promise<void> {
    try {
      await fs.access(this.artifactsBasePath);
    } catch {
      // Directory doesn't exist, create it
      await fs.mkdir(this.artifactsBasePath, { recursive: true });
      logger.info(`Created artifacts directory at ${this.artifactsBasePath}`);
    }
  }

  async cleanup(): Promise<void> {
    try {
      logger.info('Starting weekly artifact cleanup');
      
      // Ensure artifacts directory exists
      await this.ensureArtifactsDirectory();
      
      // Get all pipeline runs with expired artifacts
      const expiredRuns = await prisma.pipelineRun.findMany({
        where: {
          artifactsExpireAt: {
            lt: new Date()
          },
          artifactsCollected: true
        },
        select: {
          id: true,
          artifactsPath: true
        }
      });

      logger.info(`Found ${expiredRuns.length} runs with expired artifacts`);

      for (const run of expiredRuns) {
        try {
          // Delete artifacts from filesystem
          const artifactPath = path.join(this.artifactsBasePath, run.id);
          await fs.rm(artifactPath, { recursive: true, force: true });

          // Update database to reflect deletion
          await prisma.pipelineRun.update({
            where: { id: run.id },
            data: {
              artifactsCollected: false,
              artifactsPath: null,
              artifactsCount: 0,
              artifactsSize: 0
            }
          });

          logger.info(`Successfully cleaned up artifacts for run ${run.id}`);
        } catch (error) {
          logger.error(`Failed to cleanup artifacts for run ${run.id}:`, error);
          // Continue with next run even if this one failed
        }
      }

      // Optional: Clean up any orphaned artifact directories
      await this.cleanupOrphanedArtifacts();

      logger.info('Completed weekly artifact cleanup');
    } catch (error) {
      logger.error('Error during artifact cleanup:', error);
      throw error;
    }
  }

  private async cleanupOrphanedArtifacts(): Promise<void> {
    try {
      // Ensure artifacts directory exists
      await this.ensureArtifactsDirectory();
      
      // Get all directories in artifacts folder
      const artifactDirs = await fs.readdir(this.artifactsBasePath);

      // Get all run IDs that should have artifacts
      const validRunIds = await prisma.pipelineRun.findMany({
        where: {
          artifactsCollected: true
        },
        select: {
          id: true
        }
      });
      const validRunIdSet = new Set(validRunIds.map((run: { id: string }) => run.id));

      // Remove directories that don't correspond to valid runs
      for (const dir of artifactDirs) {
        if (!validRunIdSet.has(dir)) {
          const dirPath = path.join(this.artifactsBasePath, dir);
          try {
            await fs.rm(dirPath, { recursive: true, force: true });
            logger.info(`Removed orphaned artifact directory: ${dir}`);
          } catch (error) {
            logger.error(`Failed to remove orphaned directory ${dir}:`, error);
          }
        }
      }
    } catch (error) {
      logger.error('Error cleaning up orphaned artifacts:', error);
    }
  }
}

export function scheduleArtifactCleanup(): void {
  // Stop any existing scheduled task
  if (scheduledCleanupTask) {
    scheduledCleanupTask.stop();
    scheduledCleanupTask = null;
  }
  
  // Run at 00:00 UTC every Sunday
  scheduledCleanupTask = cron.schedule('0 0 * * 0', async () => {
    const cleanupService = new ArtifactCleanupService();
    try {
      await cleanupService.cleanup();
    } catch (error) {
      logger.error('Scheduled artifact cleanup failed:', error);
    }
  }, {
    timezone: 'UTC'
  });
  
  logger.info('Scheduled weekly artifact cleanup job');
}

export function stopArtifactCleanup(): void {
  if (scheduledCleanupTask) {
    scheduledCleanupTask.stop();
    scheduledCleanupTask = null;
    logger.info('Stopped artifact cleanup job');
  }
  
  // Also try to stop all cron tasks directly
  try {
    const tasks = (cron as any).getTasks?.();
    if (tasks) {
      const taskCount = Object.keys(tasks).length;
      if (taskCount > 0) {
        logger.info(`Stopping ${taskCount} additional cron tasks`);
        
        for (const [key, task] of Object.entries(tasks)) {
          if (task && typeof (task as any).stop === 'function') {
            (task as any).stop();
          }
        }
      }
    }
  } catch (error) {
    logger.error('Error stopping additional cron tasks:', error);
  }
} 