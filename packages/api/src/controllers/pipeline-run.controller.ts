import { Request, Response } from 'express-serve-static-core';
import { PrismaClient, Prisma } from '@prisma/client';
import { EngineService } from '../services/engine.service';
import { NotFoundError } from '../utils/errors';

interface QueryParams {
  page?: string;
  limit?: string;
  pipelineId?: string;
}

interface RouteParams {
  id: string;
}

interface StepResult {
  name: string;
  command: string;
  status: string;
  output?: string;
  error?: string;
  duration?: number;
}

interface RequestBody {
  status?: string;
  stepResults?: StepResult[];
  logs?: string[];
  error?: string;
}

// Type for routes without ID parameter (like listRuns)
export type ListRequest = Request<{}, any, RequestBody, QueryParams>;

// Type for routes with ID parameter
export type TypedRequest = Request<RouteParams, any, RequestBody, QueryParams>;

type AsyncRequestHandler = (req: TypedRequest | ListRequest, res: Response) => Promise<void>;

const prisma = new PrismaClient();
const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3001');

export class PipelineRunController {
  listRuns = async (req: ListRequest, res: Response) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 10;
      const pipelineId = req.query.pipelineId;

      // Build the where clause for filtering
      const where = pipelineId ? { pipelineId } : {};

      // Get total count for pagination
      const total = await prisma.pipelineRun.count({ where });

      // Get paginated results
      const runs = await prisma.pipelineRun.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      });

      // Transform the data to match the frontend's expected format
      const transformedRuns = runs.map(run => {
        const stepResults = Array.isArray(run.stepResults) 
          ? run.stepResults
          : (typeof run.stepResults === 'string'
            ? JSON.parse(run.stepResults)
            : []);

        return {
          id: run.id,
          pipelineId: run.pipelineId,
          status: run.status,
          branch: run.branch,
          commit: run.commit || undefined,
          createdAt: run.startedAt.toISOString(),
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString(),
          stepResults: (stepResults as unknown as StepResult[]).map(step => ({
            ...step,
            status: step.status || 'pending'
          })),
          logs: Array.isArray(run.logs) ? run.logs : [],
          error: run.error || undefined
        };
      });

      res.json({
        data: transformedRuns,
        pagination: {
          total,
          page,
          limit
        }
      });
    } catch (error) {
      console.error('[PipelineRun] Error listing runs:', error);
      res.status(500).json({ 
        error: 'Failed to list pipeline runs',
        message: 'An error occurred while fetching the pipeline runs. Please try again.'
      });
    }
  };

  getRun = async (req: TypedRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      const run = await prisma.pipelineRun.findUnique({
        where: { id },
        include: {
          pipeline: true
        }
      });

      if (!run) {
        throw new NotFoundError('Run not found');
      }

      // Transform the data to match the frontend's expected format
      const transformedRun = {
        id: run.id,
        pipelineId: run.pipelineId,
        status: run.status,
        branch: run.branch,
        commit: run.commit || undefined,
        createdAt: run.startedAt.toISOString(),
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString(),
        stepResults: Array.isArray(run.stepResults) 
          ? (run.stepResults as any[]).map(step => ({
              name: String(step?.name || ''),
              command: String(step?.command || ''),
              status: String(step?.status || ''),
              output: step?.output ? String(step.output) : undefined,
              error: step?.error ? String(step.error) : undefined,
              duration: typeof step?.duration === 'number' ? step.duration : undefined
            }))
          : (typeof run.stepResults === 'string'
            ? (JSON.parse(run.stepResults) as any[]).map(step => ({
                name: String(step?.name || ''),
                command: String(step?.command || ''),
                status: String(step?.status || ''),
                output: step?.output ? String(step.output) : undefined,
                error: step?.error ? String(step.error) : undefined,
                duration: typeof step?.duration === 'number' ? step.duration : undefined
              }))
            : []),
        logs: Array.isArray(run.logs) ? run.logs : [],
        error: run.error || undefined,
        pipeline: run.pipeline
      };

      // Add logging to help debug step status issues
      console.log(`[PipelineRunController] Get run data:`, {
        id: run.id,
        status: run.status,
        stepResults: transformedRun.stepResults
      });

      res.json(transformedRun);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        console.error('[PipelineRun] Error getting run:', error);
        res.status(500).json({ 
          error: 'Failed to get pipeline run',
          message: 'An error occurred while fetching the pipeline run. Please try again.'
        });
      }
    }
  };

  deleteRun = async (req: TypedRequest, res: Response) => {
    try {
      const { id } = req.params;
      
      // First check if the run exists
      const run = await prisma.pipelineRun.findUnique({
        where: { id }
      });

      if (!run) {
        // If run doesn't exist, it might have been already deleted by the engine
        // We'll consider this a success case
        res.status(204).send();
        return;
      }

      // Delete artifacts if they exist
      if (run.artifactsPath) {
        await engineService.deleteBuild(id);
      }

      try {
        // Try to delete the run from the database
        await prisma.pipelineRun.delete({
          where: { id }
        });
      } catch (error) {
        // If the record is already gone (deleted by engine), that's fine
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          console.log('[PipelineRun] Record already deleted by engine:', id);
        } else {
          // If it's any other database error, rethrow it
          throw error;
        }
      }

      res.status(204).send();
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        console.error('[PipelineRun] Error deleting run:', error);
        res.status(500).json({ 
          error: 'Failed to delete pipeline run',
          message: 'An error occurred while deleting the pipeline run. Please try again.'
        });
      }
    }
  };

  getRunArtifacts = async (req: TypedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const artifacts = await engineService.getBuildArtifacts(id);
      res.json(artifacts);
    } catch (error) {
      console.error('Error getting run artifacts:', error);
      res.status(500).json({ error: 'Failed to get run artifacts' });
    }
  };
  
  updateRunStatus = async (req: TypedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { status, stepResults, logs, error } = req.body;
      
      console.log(`[PipelineRunController] Updating run ${id} status to ${status}`);
      
      if (!status) {
        res.status(400).json({ error: 'Status is required' });
        return;
      }
      
      // First check if the run exists
      const run = await prisma.pipelineRun.findUnique({
        where: { id }
      });
      
      if (!run) {
        throw new NotFoundError('Run not found');
      }
      
      console.log(`[PipelineRunController] Found run ${id} with current status ${run.status}`);
      
      // Prepare update data
      const updateData: any = { status };
      if (stepResults) updateData.stepResults = stepResults;
      if (logs) updateData.logs = logs;
      if (error) updateData.error = error;
      if (status === 'completed' || status === 'failed') {
        updateData.completedAt = new Date();
      }
      
      console.log(`[PipelineRunController] Updating run ${id} in database with status ${status}`);
      
      // Update the run in the database
      const updatedRun = await prisma.pipelineRun.update({
        where: { id },
        data: updateData,
        include: { pipeline: true }
      });
      
      // If the run is completed successfully, trigger deployment if configured
      if (status === 'completed') {
        console.log(`[PipelineRunController] Run ${id} completed successfully, checking if deployment should be triggered`);
        
        // Check if deployment is enabled for this pipeline
        if (updatedRun.pipeline.deploymentEnabled) {
          console.log(`[PipelineRunController] Deployment is enabled for pipeline ${updatedRun.pipelineId}, triggering deployment`);
          
          // Trigger deployment asynchronously - don't await
          engineService.handlePipelineRunCompletion(id)
            .catch(error => {
              console.error(`[PipelineRunController] Error handling completion for run ${id}:`, error);
            });
            
          console.log(`[PipelineRunController] Deployment triggered for run ${id}`);
        } else {
          console.log(`[PipelineRunController] Deployment is not enabled for pipeline ${updatedRun.pipelineId}, skipping deployment`);
        }
      }
      
      res.json({
        id: updatedRun.id,
        status: updatedRun.status
      });
    } catch (error) {
      console.error('[PipelineRunController] Error updating run status:', error);
      
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ 
          error: 'Failed to update pipeline run status',
          message: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  };
} 