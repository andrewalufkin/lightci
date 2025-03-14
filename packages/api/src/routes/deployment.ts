import { Router } from 'express';
import { DeploymentService } from '../services/deployment.service.js';
import { EngineService } from '../services/engine.service.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { AuthenticatedRequest } from '../types/auth.js';

const router = Router();
const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3001');
const deploymentService = new DeploymentService(engineService);

// ... rest of the file unchanged ... 