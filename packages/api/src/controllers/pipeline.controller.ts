import { Request, Response } from 'express';
import { EngineService } from '../services/engine.service';
import { WorkspaceService } from '../services/workspace.service';
import { Pipeline, PipelineConfig } from '../models/Pipeline';
import { BuildStatus } from '../models/types';
import { ValidationError, NotFoundError } from '../utils/errors';

export class PipelineController {
  constructor(
    private engineService: EngineService,
    private workspaceService: WorkspaceService
  ) {}

  async listPipelines(req: Request, res: Response) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      
      const pipelines = await this.engineService.listPipelines({
        page,
        limit,
        filter: req.query.filter as string,
        sort: req.query.sort as string
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

      // Initialize pipeline in the engine
      const pipeline = await this.engineService.createPipeline({
        ...config,
        workspaceId: workspace.id
      });

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
      
      const pipeline = await this.engineService.getPipeline(id);
      console.log(`[Pipeline] Pipeline fetch result:`, pipeline ? 'Found' : 'Not found');
      
      if (!pipeline) {
        throw new NotFoundError(
          'Pipeline not found. The pipeline may have been deleted, or you may not have access to it. ' +
          'Please check the pipeline ID and try again, or return to the pipeline list to create a new one.'
        );
      }

      // Get latest builds
      console.log(`[Pipeline] Fetching latest builds for pipeline: ${id}`);
      const latestBuilds = await this.engineService.getLatestBuilds(id, 5);
      console.log(`[Pipeline] Found ${latestBuilds.length} latest builds`);
      
      res.json({
        ...pipeline,
        latestBuilds
      });
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

      // Check if pipeline exists
      const existingPipeline = await this.engineService.getPipeline(id);
      if (!existingPipeline) {
        throw new NotFoundError('Pipeline not found');
      }

      // Update pipeline in the engine
      const pipeline = await this.engineService.updatePipeline(id, config);
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

      // Check if pipeline exists
      const pipeline = await this.engineService.getPipeline(id);
      if (!pipeline) {
        throw new NotFoundError('Pipeline not found');
      }

      // Delete pipeline and its workspace
      await this.engineService.deletePipeline(id);
      await this.workspaceService.deleteWorkspace(pipeline.workspaceId);

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
      const { branch, commit, parameters } = req.body;

      // Validate pipeline exists
      const pipeline = await this.engineService.getPipeline(id);
      if (!pipeline) {
        throw new NotFoundError('Pipeline not found');
      }

      // Trigger new build
      const build = await this.engineService.triggerBuild(id, {
        branch: branch || pipeline.defaultBranch,
        commit: commit || 'HEAD',
        parameters: parameters || {}
      });

      res.json({
        buildId: build.id,
        status: build.status,
        message: `Build ${build.id} triggered successfully`
      });
    } catch (error) {
      console.error('[Pipeline] Error triggering pipeline:', error);
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ 
          error: 'Failed to trigger pipeline',
          message: error.message || 'An unexpected error occurred while triggering the pipeline'
        });
      }
    }
  }
}