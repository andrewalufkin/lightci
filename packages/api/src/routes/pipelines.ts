import { Router } from 'express';
import { PipelineController } from '../controllers/pipeline.controller';
import { PipelineService } from '../services/pipeline.service';
import { WorkspaceService } from '../services/workspace.service';
import { validateSchema } from '../middleware/validation';
import { authenticate } from '../middleware/auth';

const router = Router();
const pipelineService = new PipelineService();
const workspaceService = new WorkspaceService();
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
      additionalProperties: true
    }
  },
  // If triggers.events includes 'push', githubToken is required
  allOf: [{
    if: {
      properties: {
        triggers: {
          properties: {
            events: {
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
