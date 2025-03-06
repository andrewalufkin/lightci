import { Router } from 'express';
import { RequestHandler } from 'express-serve-static-core';
import { validateSchema } from '../middleware/validation';
import { authenticate } from '../middleware/auth';
import { ProjectController } from '../controllers/project.controller';
import { ProjectService } from '../services/project.service';

const router = Router();
const projectService = new ProjectService();
const projectController = new ProjectController(projectService);

// Project schema validation
const projectSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { 
      type: 'string', 
      minLength: 1 
    },
    description: { 
      type: 'string' 
    },
    visibility: { 
      type: 'string',
      enum: ['private', 'public'],
      default: 'private'
    },
    defaultBranch: { 
      type: 'string' 
    },
    pipelineIds: {
      type: 'array',
      items: { 
        type: 'string',
        format: 'uuid'
      }
    },
    settings: {
      type: 'object',
      additionalProperties: true
    }
  }
};

// Create new project
router.post('/', 
  authenticate as RequestHandler, 
  validateSchema(projectSchema),
  projectController.createProject.bind(projectController) as unknown as RequestHandler
);

// List all projects
router.get('/', 
  authenticate as RequestHandler, 
  projectController.listProjects.bind(projectController) as unknown as RequestHandler
);

// Get project details
router.get('/:id', 
  authenticate as RequestHandler, 
  projectController.getProject.bind(projectController) as unknown as RequestHandler
);

// Update project
router.put('/:id',
  authenticate as RequestHandler,
  validateSchema(projectSchema),
  projectController.updateProject.bind(projectController) as unknown as RequestHandler
);

// Delete project
router.delete('/:id',
  authenticate as RequestHandler,
  projectController.deleteProject.bind(projectController) as unknown as RequestHandler
);

export { router as projectRouter }; 