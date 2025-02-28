import express from 'express';
import { DeploymentController } from '../controllers/deployment.controller';

export const deploymentRouter = express.Router();
const deploymentController = new DeploymentController();

// Trigger a deployment for a specific pipeline run
deploymentRouter.post('/runs/:runId/deploy', (req, res) => deploymentController.triggerDeployment(req, res));

// Get the deployment status for a specific pipeline run
deploymentRouter.get('/runs/:runId/status', (req, res) => deploymentController.getDeploymentStatus(req, res));