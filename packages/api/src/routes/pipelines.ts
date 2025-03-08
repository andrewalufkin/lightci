import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express-serve-static-core';
import { PipelineController } from '../controllers/pipeline.controller';
import { PipelineService } from '../services/pipeline.service';
import { WorkspaceService } from '../services/workspace.service';
import { validateSchema } from '../middleware/validation';
import { authenticate } from '../middleware/auth.middleware';
import { EngineService } from '../services/engine.service';
import { SchedulerService } from '../services/scheduler.service';
import { PipelineRunnerService } from '../services/pipeline-runner.service';
import type { AuthenticatedRequest } from '../types/auth';
import { prisma } from '../lib/prisma';
import { testDb } from '../test/utils/testDb';
import { MockPipelineRunnerService } from '../test/fixtures/mock-services';

// Check if we're in a test environment
const isTest = process.env.NODE_ENV === 'test';

const router = Router();
const workspaceService = new WorkspaceService();

// Use mock services in test mode
const pipelineRunnerService = isTest 
  ? new MockPipelineRunnerService(workspaceService, testDb)
  : new PipelineRunnerService(workspaceService);

const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3001');
const schedulerService = new SchedulerService(pipelineRunnerService);

// Use testDb in tests, otherwise use the regular prisma client
const dbClient = isTest ? testDb : prisma;
const pipelineService = new PipelineService(engineService, schedulerService, dbClient);
const pipelineController = new PipelineController(pipelineService, workspaceService);

// Pipeline schema validation
const pipelineSchema = {
  type: 'object',
  required: ['name', 'repository', 'steps'],
  properties: {
    name: { type: 'string', minLength: 1 },
    repository: { type: 'string', format: 'uri' },
    description: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['name', 'command'],
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          timeout: { type: 'number', minimum: 0 },
          environment: {
            type: 'object',
            additionalProperties: { type: 'string' }
          }
        }
      }
    },
    defaultBranch: { type: 'string' },
    triggers: {
      type: 'object',
      properties: {
        branches: { type: 'array', items: { type: 'string' } },
        events: { 
          type: 'array', 
          items: { 
            type: 'string',
            enum: ['push', 'pull_request']
          }
        }
      }
    },
    schedule: {
      type: 'object',
      properties: {
        cron: { type: 'string' },
        timezone: { type: 'string' }
      }
    },
    githubToken: { 
      type: 'string',
      minLength: 1,
      description: 'GitHub Personal Access Token with repo and admin:repo_hook scopes'
    },
    artifactsEnabled: { type: 'boolean' },
    artifactPatterns: {
      type: 'array',
      items: { type: 'string' }
    },
    artifactRetentionDays: { type: 'integer', minimum: 1 },
    artifactStorageType: { 
      type: 'string',
      enum: ['local', 's3']
    },
    artifactStorageConfig: {
      type: 'object',
      properties: {
        bucketName: { type: 'string' },
        region: { type: 'string' },
        credentialsId: { type: 'string' }
      }
    },
    deploymentEnabled: { type: 'boolean' },
    deploymentPlatform: {
      type: 'string',
      enum: ['aws', 'gcp', 'azure', 'kubernetes', 'custom']
    },
    deploymentConfig: {
      type: 'object',
      additionalProperties: true
    }
  },
  // If triggers.events includes 'push', githubToken is required
  allOf: [{
    if: {
      required: ['triggers'],
      properties: {
        triggers: {
          required: ['events'],
          properties: {
            events: {
              type: 'array',
              contains: { const: 'push' }
            }
          }
        }
      }
    },
    then: {
      required: ['githubToken']
    }
  }]
};

// Separate schema for pipeline updates that allows partial updates
const pipelineUpdateSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    repository: { type: 'string', format: 'uri' },
    description: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'command'],
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          timeout: { type: 'number', minimum: 0 },
          environment: {
            type: 'object',
            additionalProperties: { type: 'string' }
          }
        }
      }
    },
    defaultBranch: { type: 'string' },
    triggers: {
      type: 'object',
      properties: {
        branches: { type: 'array', items: { type: 'string' } },
        events: { 
          type: 'array', 
          items: { 
            type: 'string',
            enum: ['push', 'pull_request']
          }
        }
      }
    },
    schedule: {
      type: 'object',
      properties: {
        cron: { type: 'string' },
        timezone: { type: 'string' }
      }
    },
    githubToken: { 
      type: 'string',
      minLength: 1,
      description: 'GitHub Personal Access Token with repo and admin:repo_hook scopes'
    },
    artifactsEnabled: { type: 'boolean' },
    artifactPatterns: {
      type: 'array',
      items: { type: 'string' }
    },
    artifactRetentionDays: { type: 'integer', minimum: 1 },
    artifactStorageType: { 
      type: 'string',
      enum: ['local', 's3']
    },
    artifactStorageConfig: {
      type: 'object',
      properties: {
        bucketName: { type: 'string' },
        region: { type: 'string' },
        credentialsId: { type: 'string' }
      }
    },
    deploymentEnabled: { type: 'boolean' },
    deploymentPlatform: {
      type: 'string',
      enum: ['aws', 'gcp', 'azure', 'kubernetes', 'custom']
    },
    deploymentConfig: {
      type: 'object',
      additionalProperties: true
    }
  }
};

// List all pipelines
router.get('/', authenticate, (req: Request, res: Response, next: NextFunction) => {
  return pipelineController.listPipelines(req as AuthenticatedRequest, res).catch(next);
});

// Create new pipeline
router.post('/', 
  authenticate,
  validateSchema(pipelineSchema),
  (req: Request, res: Response, next: NextFunction) => {
    return pipelineController.createPipeline(req as AuthenticatedRequest, res).catch(next);
  }
);

// Get pipeline details
router.get('/:id', 
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    return pipelineController.getPipeline(req as AuthenticatedRequest, res).catch(next);
  }
);

// Update pipeline
router.put('/:id',
  authenticate,
  validateSchema(pipelineUpdateSchema),
  (req: Request, res: Response, next: NextFunction) => {
    return pipelineController.updatePipeline(req as AuthenticatedRequest, res).catch(next);
  }
);

// Delete pipeline
router.delete('/:id',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    return pipelineController.deletePipeline(req as AuthenticatedRequest, res).catch(next);
  }
);

// Trigger pipeline
router.post('/:id/trigger',
  authenticate,
  (req: Request, res: Response, next: NextFunction) => {
    return pipelineController.triggerPipeline(req as AuthenticatedRequest, res).catch(next);
  }
);

export { router as pipelineRouter };
