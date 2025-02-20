import { Router } from 'express';
import { PipelineController } from '../controllers/pipeline.controller';
import { EngineService } from '../services/engine.service';
import { WorkspaceService } from '../services/workspace.service';
import { validateSchema } from '../middleware/validation';
import { authenticate } from '../middleware/auth';

const router = Router();
const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'localhost:50051');
const workspaceService = new WorkspaceService();
const pipelineController = new PipelineController(engineService, workspaceService);

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
    }
  }
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

// Trigger pipeline run
router.post('/:id/trigger',
  authenticate,
  validateSchema({
    type: 'object',
    properties: {
      branch: { type: 'string' },
      commit: { type: 'string' },
      parameters: {
        type: 'object',
        additionalProperties: { type: 'string' }
      }
    }
  }),
  pipelineController.triggerPipeline.bind(pipelineController)
);

export { router as pipelineRouter };
