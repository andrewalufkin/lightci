import express, { Request, Response } from 'express';
import { DeploymentController } from '../controllers/deployment.controller';
import { RequestWithParams } from '../types/express';

export const deploymentRouter = express.Router();
const deploymentController = new DeploymentController();

// Trigger a deployment for a specific pipeline run
deploymentRouter.post('/runs/:runId/deploy', (req: Request, res: Response) => {
  const typedReq = req as RequestWithParams;
  return deploymentController.triggerDeployment(typedReq, res);
});

// Get the deployment status for a specific pipeline run
deploymentRouter.get('/runs/:runId/status', (req: Request, res: Response) => {
  const typedReq = req as RequestWithParams;
  return deploymentController.getDeploymentStatus(typedReq, res);
});