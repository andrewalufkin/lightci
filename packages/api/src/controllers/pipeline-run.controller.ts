import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class PipelineRunController {
  async listRuns(req: Request, res: Response) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const pipelineId = req.query.pipelineId as string;

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
        console.log(`[PipelineRunController] Raw run data:`, {
          id: run.id,
          status: run.status,
          stepResults: run.stepResults
        });

        // Ensure stepResults is an array
        const stepResults = Array.isArray(run.stepResults) 
          ? run.stepResults 
          : (typeof run.stepResults === 'string' 
            ? JSON.parse(run.stepResults) 
            : []);

        const transformed = {
          id: run.id,
          pipelineId: run.pipelineId,
          status: run.status,
          branch: run.branch,
          commit: run.commit || undefined,
          createdAt: run.startedAt.toISOString(),
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString(),
          stepResults: stepResults.map((step: any) => ({
            ...step,
            status: step.status || 'pending'
          })),
          logs: Array.isArray(run.logs) ? run.logs : [],
          error: run.error || undefined
        };

        console.log(`[PipelineRunController] Transformed run data:`, {
          id: transformed.id,
          status: transformed.status,
          stepResults: transformed.stepResults
        });

        return transformed;
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
  }

  async getRun(req: Request, res: Response) {
    try {
      const { id } = req.params;
      
      const run = await prisma.pipelineRun.findUnique({
        where: { id },
        include: {
          pipeline: true
        }
      });

      if (!run) {
        return res.status(404).json({ 
          error: 'Pipeline run not found',
          message: 'The requested pipeline run could not be found.'
        });
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
          ? run.stepResults.map((step: any) => ({
              ...step,
              status: step.status || 'pending'
            }))
          : (typeof run.stepResults === 'string'
            ? JSON.parse(run.stepResults).map((step: any) => ({
                ...step,
                status: step.status || 'pending'
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
      console.error('[PipelineRun] Error getting run:', error);
      res.status(500).json({ 
        error: 'Failed to get pipeline run',
        message: 'An error occurred while fetching the pipeline run. Please try again.'
      });
    }
  }

  async deleteRun(req: Request, res: Response) {
    try {
      const { id } = req.params;
      
      const run = await prisma.pipelineRun.findUnique({
        where: { id }
      });

      if (!run) {
        return res.status(404).json({ 
          error: 'Pipeline run not found',
          message: 'The requested pipeline run could not be found.'
        });
      }

      await prisma.pipelineRun.delete({
        where: { id }
      });

      res.status(204).send();
    } catch (error) {
      console.error('[PipelineRun] Error deleting run:', error);
      res.status(500).json({ 
        error: 'Failed to delete pipeline run',
        message: 'An error occurred while deleting the pipeline run. Please try again.'
      });
    }
  }
} 