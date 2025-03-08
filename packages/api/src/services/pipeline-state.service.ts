import { PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';

export class PipelineStateService {
  public static readonly PIPELINE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  async recoverStuckPipelines() {
    console.log('[PipelineStateService] Checking for stuck pipelines...');
    
    try {
      // Find all pipelines marked as running
      const runningPipelines = await prisma.pipeline.findMany({
        where: { status: 'running' },
        include: {
          runs: {
            orderBy: { startedAt: 'desc' },
            take: 1,
          },
        },
      });

      console.log(`[PipelineStateService] Found ${runningPipelines.length} running pipelines`);

      for (const pipeline of runningPipelines) {
        const latestRun = pipeline.runs[0];
        
        if (!latestRun) {
          // No runs found, mark as failed
          await this.markPipelineFailed(pipeline.id, 'No pipeline runs found');
          continue;
        }

        const now = new Date();
        const runStartTime = new Date(latestRun.startedAt);
        const timeDiff = now.getTime() - runStartTime.getTime();

        if (timeDiff > PipelineStateService.PIPELINE_TIMEOUT_MS) {
          // Pipeline has been running too long, mark as failed
          await this.markPipelineFailed(pipeline.id, 'Pipeline execution timeout');
          await this.markRunFailed(latestRun.id, 'Pipeline execution timeout');
        } else if (latestRun.status === 'failed' || latestRun.status === 'completed') {
          // Pipeline run has finished but pipeline status wasn't updated
          await prisma.pipeline.update({
            where: { id: pipeline.id },
            data: { status: latestRun.status },
          });
        }
      }
    } catch (error) {
      console.error('[PipelineStateService] Error recovering stuck pipelines:', error);
    }
  }

  async markPipelineFailed(pipelineId: string, reason: string) {
    console.log(`[PipelineStateService] Marking pipeline ${pipelineId} as failed: ${reason}`);
    
    await prisma.pipeline.update({
      where: { id: pipelineId },
      data: { status: 'failed' },
    });
  }

  async markRunFailed(runId: string, reason: string) {
    console.log(`[PipelineStateService] Marking run ${runId} as failed: ${reason}`);
    
    await prisma.pipelineRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        error: reason,
      },
    });
  }

  async cleanupRunningPipelines() {
    console.log('[PipelineStateService] Cleaning up running pipelines...');
    
    try {
      // Find all running pipelines
      const runningPipelines = await prisma.pipeline.findMany({
        where: { status: 'running' },
        include: {
          runs: {
            where: { status: 'running' },
          },
        },
      });

      // Mark them all as failed due to server shutdown
      for (const pipeline of runningPipelines) {
        await this.markPipelineFailed(pipeline.id, 'Server shutdown');
        
        for (const run of pipeline.runs) {
          await this.markRunFailed(run.id, 'Server shutdown');
        }
      }
    } catch (error) {
      console.error('[PipelineStateService] Error cleaning up running pipelines:', error);
    }
  }
} 