import { Request, Response } from 'express-serve-static-core';
import { PipelineService } from '../services/pipeline.service.js';
import { WorkspaceService } from '../services/workspace.service.js';
import { PipelineRunnerService } from '../services/pipeline-runner.service.js';
import { Pipeline, PipelineConfig } from '../models/Pipeline.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { SchedulerService } from '../services/scheduler.service.js';
import { prisma } from '../lib/prisma.js';

interface PipelineQueryParams {
  page?: string;
  limit?: string;
  filter?: string;
  sort?: string;
}

interface PipelineTriggerBody {
  branch?: string;
  commit?: string;
}

export class PipelineController {
  private pipelineRunnerService: PipelineRunnerService;
  private pipelineService: PipelineService;
  private workspaceService: WorkspaceService;
  private schedulerService: SchedulerService;

  constructor(
    pipelineService: PipelineService, 
    workspaceService: WorkspaceService,
    pipelineRunnerService: PipelineRunnerService,
    schedulerService: SchedulerService
  ) {
    this.pipelineService = pipelineService;
    this.workspaceService = workspaceService;
    this.pipelineRunnerService = pipelineRunnerService;
    this.schedulerService = schedulerService;
  }

  public async listPipelines(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      
      const pipelines = await this.pipelineService.listPipelines({
        page,
        limit,
        filter: req.query.filter as string,
        userId: req.user.id
      });
      
      res.json({
        data: pipelines.items || [],
        pagination: {
          page,
          limit,
          total: pipelines.total
        }
      });
    } catch (error) {
      console.error('Error listing pipelines:', error);
      res.status(500).json({ error: 'Failed to list pipelines' });
    }
  }

  public async createPipeline(req: AuthenticatedRequest, res: Response) {
    try {
      const config = req.body as PipelineConfig;
      
      // Validate pipeline configuration
      if (!config.steps || config.steps.length === 0) {
        throw new ValidationError('Pipeline must contain at least one step');
      }

      // Create workspace for the pipeline
      const workspace = await this.workspaceService.createWorkspace({
        name: config.name,
        repository: config.repository
      });

      // Initialize pipeline with user ID
      const pipeline = await this.pipelineService.createPipeline(config, req.user.id);

      res.status(201).json(pipeline);
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        console.error('Pipeline creation error:', error);
        res.status(500).json({ error: 'Failed to create pipeline' });
      }
    }
  }

  public async getPipeline(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const pipelineId = req.params.id;
      const pipeline = await this.pipelineService.getPipeline(pipelineId, req.user.id);
      if (!pipeline) {
        throw new NotFoundError('Pipeline not found');
      }
      res.json({ data: pipeline });
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        console.error('Error getting pipeline:', error);
        res.status(500).json({ error: 'Failed to get pipeline' });
      }
    }
  }

  public async updatePipeline(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const pipelineId = req.params.id;
      const updates = req.body;
      const pipeline = await this.pipelineService.updatePipeline(pipelineId, updates, req.user.id);
      res.json({ data: pipeline });
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        console.error('Error updating pipeline:', error);
        res.status(500).json({ error: 'Failed to update pipeline' });
      }
    }
  }

  public async deletePipeline(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const pipelineId = req.params.id;
      await this.pipelineService.deletePipeline(pipelineId, req.user.id);
      res.status(204).send();
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        console.error('Error deleting pipeline:', error);
        res.status(500).json({ error: 'Failed to delete pipeline' });
      }
    }
  }

  public async triggerPipeline(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const pipelineId = req.params.id;
      const { branch, commit } = req.body as PipelineTriggerBody;
      
      // Get pipeline first to verify access and get repository
      const pipeline = await this.pipelineService.getPipeline(pipelineId, req.user.id);
      if (!pipeline) {
        throw new NotFoundError('Pipeline not found or access denied');
      }

      const run = await this.pipelineService.createPipelineRun({
        pipelineId,
        branch: branch || pipeline.defaultBranch || 'main',
        commit: commit || '',
        status: 'running',
        triggeredBy: req.user.id,
        repository: pipeline.repository
      });

      // Start pipeline execution in background with the existing run ID
      this.pipelineRunnerService.runPipeline(pipelineId, branch || pipeline.defaultBranch || 'main', req.user.id, commit, run.id)
        .catch(error => {
          console.error(`[PipelineController] Error running pipeline ${pipelineId}:`, error);
        });

      res.status(201).json({
        message: 'Pipeline triggered successfully',
        runId: run.id,
        status: 'running'
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        console.error('Error triggering pipeline:', error);
        res.status(500).json({ error: 'Failed to trigger pipeline' });
      }
    }
  }
}