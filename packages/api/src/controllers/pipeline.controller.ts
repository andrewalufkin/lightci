import { Request, Response } from 'express';
import { PipelineService } from '../services/pipeline.service';
import { WorkspaceService } from '../services/workspace.service';
import { PipelineRunnerService } from '../services/pipeline-runner.service';
import { Pipeline, PipelineConfig } from '../models/Pipeline';
import { ValidationError, NotFoundError } from '../utils/errors';

export class PipelineController {
  private pipelineRunnerService: PipelineRunnerService;

  constructor(
    private pipelineService: PipelineService,
    private workspaceService: WorkspaceService
  ) {
    this.pipelineRunnerService = new PipelineRunnerService(workspaceService);
  }

  async listPipelines(req: Request, res: Response) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      
      const pipelines = await this.pipelineService.listPipelines({
        page,
        limit,
        filter: req.query.filter as string,
        sort: req.query.sort as string,
        userId: req.user.id
      });
      
      // Even if no pipelines exist, return a valid response with empty items
      res.json({
        data: pipelines.items || [],
        pagination: {
          total: pipelines.total || 0,
          page: pipelines.page,
          limit: pipelines.limit,
          isEmpty: pipelines.total === 0
        },
        message: pipelines.total === 0 ? "No pipelines found. Create your first pipeline to get started!" : undefined
      });
    } catch (error) {
      console.error('[Pipeline] Error listing pipelines:', error);
      res.status(500).json({ 
        error: 'Failed to list pipelines',
        message: 'An error occurred while fetching the pipeline list. Please try again.'
      });
    }
  }

  async createPipeline(req: Request, res: Response) {
    try {
      const config: PipelineConfig = req.body;
      
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

  async getPipeline(req: Request, res: Response) {
    try {
      const { id } = req.params;
      console.log(`[Pipeline] Fetching pipeline with ID: ${id}`);
      
      const pipeline = await this.pipelineService.getPipeline(id, req.user.id);
      console.log(`[Pipeline] Pipeline fetch result:`, pipeline ? 'Found' : 'Not found');
      
      if (!pipeline) {
        throw new NotFoundError(
          'Pipeline not found. The pipeline may have been deleted, or you may not have access to it. ' +
          'Please check the pipeline ID and try again, or return to the pipeline list to create a new one.'
        );
      }

      res.json(pipeline);
    } catch (error) {
      console.error('[Pipeline] Error in getPipeline:', error);
      if (error instanceof NotFoundError) {
        res.status(404).json({ 
          error: error.message,
          code: 'PIPELINE_NOT_FOUND'
        });
      } else {
        console.error('[Pipeline] Detailed error:', {
          name: error.name,
          message: error.message,
          stack: error.stack,
        });
        res.status(500).json({ 
          error: 'Failed to get pipeline',
          message: 'An unexpected error occurred while fetching the pipeline details. Please try again.',
          code: 'INTERNAL_ERROR'
        });
      }
    }
  }

  async updatePipeline(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const config: PipelineConfig = req.body;

      // Check if pipeline exists and user has access
      const existingPipeline = await this.pipelineService.getPipeline(id, req.user.id);
      if (!existingPipeline) {
        throw new NotFoundError('Pipeline not found or access denied');
      }

      // Update pipeline
      const pipeline = await this.pipelineService.updatePipeline(id, config, req.user.id);
      res.json(pipeline);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to update pipeline' });
      }
    }
  }

  async deletePipeline(req: Request, res: Response) {
    try {
      const { id } = req.params;

      // Check if pipeline exists and user has access
      const pipeline = await this.pipelineService.getPipeline(id, req.user.id);
      if (!pipeline) {
        throw new NotFoundError('Pipeline not found or access denied');
      }

      // Delete pipeline
      await this.pipelineService.deletePipeline(id, req.user.id);

      res.status(204).send();
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to delete pipeline' });
      }
    }
  }

  async triggerPipeline(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { branch, commit } = req.body;

      // Get pipeline and verify access
      const pipeline = await this.pipelineService.getPipeline(id, req.user.id);
      if (!pipeline) {
        throw new NotFoundError('Pipeline not found or access denied');
      }

      // Use default branch if none specified
      const targetBranch = branch || pipeline.defaultBranch;

      // Trigger pipeline run
      const runId = await this.pipelineRunnerService.runPipeline(id, targetBranch, commit);

      res.json({
        message: 'Pipeline triggered successfully',
        runId,
        status: 'running'
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        console.error('Failed to trigger pipeline:', error);
        res.status(500).json({ error: 'Failed to trigger pipeline' });
      }
    }
  }
}