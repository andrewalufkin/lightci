import { Request, Response } from 'express';
import { DeploymentService, DeploymentResult } from '../services/deployment.service';
import { NotFoundError } from '../utils/errors';
import { prisma } from '../db';

export class DeploymentController {
  private deploymentService: DeploymentService;
  
  constructor() {
    this.deploymentService = new DeploymentService();
  }
  
  /**
   * Trigger a deployment for a successful pipeline run
   */
  async triggerDeployment(req: Request, res: Response): Promise<void> {
    try {
      const { runId } = req.params;
      
      if (!runId) {
        res.status(400).json({ error: 'Run ID is required' });
        return;
      }
      
      // Get the run to check if it exists and is completed
      const run = await prisma.pipelineRun.findUnique({
        where: { id: runId },
        include: { pipeline: true }
      });
      
      if (!run) {
        res.status(404).json({ error: 'Pipeline run not found' });
        return;
      }
      
      // Check if the run is completed
      if (run.status !== 'completed') {
        res.status(400).json({ 
          error: 'Cannot deploy a failed or incomplete pipeline run',
          status: run.status
        });
        return;
      }
      
      // Check if deployment is enabled for this pipeline
      if (!run.pipeline.deploymentEnabled) {
        res.status(400).json({ 
          error: 'Deployment is not enabled for this pipeline',
          pipeline: run.pipelineId
        });
        return;
      }
      
      // Trigger deployment in the background
      const deploymentPromise = this.deploymentService.deployPipelineRun(runId);
      
      // Respond immediately to client
      res.status(202).json({ 
        message: 'Deployment triggered',
        runId,
        pipelineId: run.pipelineId,
        platform: run.pipeline.deploymentPlatform
      });
      
      // Wait for deployment to complete and log results (but don't block the response)
      deploymentPromise
        .then(result => {
          console.log(`[DeploymentController] Deployment for run ${runId} completed with status: ${result.success ? 'success' : 'failure'}`);
        })
        .catch(error => {
          console.error(`[DeploymentController] Error during deployment for run ${runId}:`, error);
        });
    } catch (error) {
      console.error('[DeploymentController] Error triggering deployment:', error);
      const statusCode = error instanceof NotFoundError ? 404 : 500;
      res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
  
  /**
   * Check the deployment status for a pipeline run
   */
  async getDeploymentStatus(req: Request, res: Response): Promise<void> {
    try {
      const { runId } = req.params;
      
      if (!runId) {
        res.status(400).json({ error: 'Run ID is required' });
        return;
      }
      
      // Get the run with its deployment information
      const run = await prisma.pipelineRun.findUnique({
        where: { id: runId },
        include: { pipeline: true }
      });
      
      if (!run) {
        res.status(404).json({ error: 'Pipeline run not found' });
        return;
      }
      
      // Extract deployment logs from run logs
      const deploymentLogs = run.logs && Array.isArray(run.logs) 
        ? run.logs.filter(log => typeof log === 'string' && log.startsWith('[DEPLOYMENT]')) 
        : [];
      
      // Determine deployment status based on logs
      let deploymentStatus = 'not_started';
      let deploymentMessage = 'No deployment has been triggered';
      
      if (deploymentLogs.length > 0) {
        const lastLog = deploymentLogs[deploymentLogs.length - 1] as string;
        
        if (lastLog.includes('Successfully deployed')) {
          deploymentStatus = 'completed';
          deploymentMessage = 'Deployment completed successfully';
        } else if (lastLog.includes('Deployment failed') || lastLog.includes('Deployment error')) {
          deploymentStatus = 'failed';
          deploymentMessage = 'Deployment failed';
        } else {
          deploymentStatus = 'in_progress';
          deploymentMessage = 'Deployment is in progress';
        }
      }
      
      res.json({
        runId,
        pipelineId: run.pipelineId,
        deploymentEnabled: run.pipeline.deploymentEnabled,
        deploymentPlatform: run.pipeline.deploymentPlatform,
        deploymentStatus,
        deploymentMessage,
        deploymentLogs: deploymentLogs.map(log => {
          // Remove the '[DEPLOYMENT]' prefix for cleaner output
          return typeof log === 'string' ? log.replace('[DEPLOYMENT] ', '') : log;
        })
      });
    } catch (error) {
      console.error('[DeploymentController] Error getting deployment status:', error);
      const statusCode = error instanceof NotFoundError ? 404 : 500;
      res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
}