import { PrismaClient } from '@prisma/client';
import { prisma } from '../db';
import { PipelineRunnerService } from './pipeline-runner.service';
import * as cron from 'node-cron';
import { Pipeline } from '../models/Pipeline';
import { PipelineService } from './pipeline.service';
import { EngineService } from './engine.service';
import { WorkspaceService } from './workspace.service';

export class SchedulerService {
  private scheduledJobs: Map<string, cron.ScheduledTask>;
  private pipelineRunnerService: PipelineRunnerService;
  private pipelineService: PipelineService;

  constructor(pipelineRunnerService: PipelineRunnerService) {
    this.scheduledJobs = new Map();
    this.pipelineRunnerService = pipelineRunnerService;
    const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3001');
    this.pipelineService = new PipelineService(engineService);
  }

  async initialize() {
    console.log('[SchedulerService] Initializing scheduler service...');
    
    try {
      // Get all pipelines with schedules
      const pipelines = await prisma.pipeline.findMany({
        where: {
          schedule: {
            not: undefined
          }
        }
      });

      console.log(`[SchedulerService] Found ${pipelines.length} pipelines with schedules`);

      // Schedule each pipeline
      for (const pipeline of pipelines) {
        const modelPipeline = await this.pipelineService.getPipeline(pipeline.id, 'system');
        if (modelPipeline) {
          await this.schedulePipeline(modelPipeline);
        }
      }

      console.log('[SchedulerService] Scheduler service initialized successfully');
    } catch (error) {
      console.error('[SchedulerService] Error initializing scheduler service:', error);
    }
  }

  async schedulePipeline(pipeline: Pipeline) {
    try {
      // Remove existing schedule if any
      this.unschedulePipeline(pipeline.id);

      const schedule = pipeline.schedule;
      if (!schedule || !schedule.cron) {
        return;
      }

      // Validate cron expression
      if (!cron.validate(schedule.cron)) {
        console.error(`[SchedulerService] Invalid cron expression for pipeline ${pipeline.id}: ${schedule.cron}`);
        return;
      }

      console.log(`[SchedulerService] Scheduling pipeline ${pipeline.id} with cron: ${schedule.cron}`);

      // Schedule the pipeline
      const job = cron.schedule(schedule.cron, async () => {
        try {
          console.log(`[SchedulerService] Triggering scheduled run for pipeline ${pipeline.id}`);
          await this.pipelineRunnerService.runPipeline(pipeline.id, pipeline.defaultBranch);
        } catch (error) {
          console.error(`[SchedulerService] Error running scheduled pipeline ${pipeline.id}:`, error);
        }
      }, {
        timezone: schedule.timezone || 'UTC'
      });

      // Store the scheduled job
      this.scheduledJobs.set(pipeline.id, job);

      console.log(`[SchedulerService] Successfully scheduled pipeline ${pipeline.id}`);
    } catch (error) {
      console.error(`[SchedulerService] Error scheduling pipeline ${pipeline.id}:`, error);
    }
  }

  unschedulePipeline(pipelineId: string) {
    const job = this.scheduledJobs.get(pipelineId);
    if (job) {
      job.stop();
      this.scheduledJobs.delete(pipelineId);
      console.log(`[SchedulerService] Unscheduled pipeline ${pipelineId}`);
    }
  }

  async updatePipelineSchedule(pipeline: Pipeline) {
    await this.schedulePipeline(pipeline);
  }

  stopAll() {
    Array.from(this.scheduledJobs.entries()).forEach(([pipelineId, job]) => {
      job.stop();
      console.log(`[SchedulerService] Stopped schedule for pipeline ${pipelineId}`);
    });
    this.scheduledJobs.clear();
  }
} 