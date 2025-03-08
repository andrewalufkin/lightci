import { Request, Response } from 'express';
import { DeploymentService, DeploymentResult, DeploymentConfig } from '../services/deployment.service.js';
import { NotFoundError } from '../utils/errors.js';
import { prisma } from '../db.js';
import { RequestWithParams } from '../types/express.js';

export class DeploymentController {
  private deploymentService: DeploymentService;
  
  constructor() {
    this.deploymentService = new DeploymentService();
  }
  
  /**
   * Trigger a deployment for a successful pipeline run
   */
  async triggerDeployment(req: RequestWithParams, res: Response): Promise<void> {
    try {
      const { runId } = req.params;
      
      if (!runId) {
        (res as any).status(400).json({ error: 'Run ID is required' });
        return;
      }
      
      // Get the run to check if it exists and is completed
      const run = await prisma.pipelineRun.findUnique({
        where: { id: runId },
        include: { pipeline: true }
      });
      
      if (!run) {
        (res as any).status(404).json({ error: 'Pipeline run not found' });
        return;
      }
      
      // Check if the run is completed
      if (run.status !== 'completed') {
        (res as any).status(400).json({ 
          error: 'Cannot deploy a failed or incomplete pipeline run',
          status: run.status
        });
        return;
      }
      
      // Check if deployment is enabled for this pipeline
      if (!run.pipeline.deploymentEnabled) {
        (res as any).status(400).json({ 
          error: 'Deployment is not enabled for this pipeline',
          pipeline: run.pipelineId
        });
        return;
      }
      
      // Create deployment config from pipeline configuration
      const deploymentConfig: DeploymentConfig = {
        platform: run.pipeline.deploymentPlatform || 'custom',
        config: run.pipeline.deploymentConfig as Record<string, any> || {},
      };
      
      // Trigger deployment in the background
      const deploymentPromise = this.deploymentService.deployPipelineRun(runId, deploymentConfig);
      
      // Respond immediately to client
      (res as any).status(202).json({ 
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
      (res as any).status(statusCode).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
  
  /**
   * Check the deployment status for a pipeline run
   */
  async getDeploymentStatus(req: RequestWithParams, res: Response): Promise<void> {
    try {
      const { runId } = req.params;
      
      if (!runId) {
        (res as any).status(400).json({ error: 'Run ID is required' });
        return;
      }
      
      // Get the run with its deployment information
      const run = await prisma.pipelineRun.findUnique({
        where: { id: runId },
        include: { pipeline: true }
      });
      
      if (!run) {
        (res as any).status(404).json({ error: 'Pipeline run not found' });
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
      
      const responseData = {
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
      };
      
      (res as any).json(responseData);
    } catch (error) {
      console.error('[DeploymentController] Error getting deployment status:', error);
      const statusCode = error instanceof NotFoundError ? 404 : 500;
      (res as any).status(statusCode).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
}