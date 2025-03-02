import { Router } from 'express';
import { PipelineController } from '../controllers/pipeline.controller';
import { PipelineService } from '../services/pipeline.service';
import { WorkspaceService } from '../services/workspace.service';
import { validateSchema } from '../middleware/validation';
import { authenticate } from '../middleware/auth';
import { EngineService } from '../services/engine.service';
import { SchedulerService } from '../services/scheduler.service';
import { PipelineRunnerService } from '../services/pipeline-runner.service';

const router = Router();
const workspaceService = new WorkspaceService();
const pipelineRunnerService = new PipelineRunnerService(workspaceService);
const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3001');
const schedulerService = new SchedulerService(pipelineRunnerService);
const pipelineService = new PipelineService(engineService, schedulerService);
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

// List all pipelines
router.get('/', authenticate, pipelineController.listPipelines.bind(pipelineController));

// Create new pipeline
router.post('/', 
  authenticate, 
  validateSchema(pipelineSchema),
  pipelineController.createPipeline.bind(pipelineController)
);

// Get pipeline details
router.get('/:id', 
  authenticate, 
  pipelineController.getPipeline.bind(pipelineController)
);

// Update pipeline
router.put('/:id',
  authenticate,
  validateSchema(pipelineSchema),
  pipelineController.updatePipeline.bind(pipelineController)
);

// Delete pipeline
router.delete('/:id',
  authenticate,
  pipelineController.deletePipeline.bind(pipelineController)
);

// Trigger pipeline
router.post('/:id/trigger',
  authenticate,
  pipelineController.triggerPipeline.bind(pipelineController)
);

export { router as pipelineRouter };
