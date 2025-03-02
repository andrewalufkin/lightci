import { Router } from 'express';
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
  authenticate, 
  validateSchema(projectSchema),
  projectController.createProject.bind(projectController)
);

// List all projects
router.get('/', 
  authenticate, 
  projectController.listProjects.bind(projectController)
);

// Get project details
router.get('/:id', 
  authenticate, 
  projectController.getProject.bind(projectController)
);

// Update project
router.put('/:id',
  authenticate,
  validateSchema(projectSchema),
  projectController.updateProject.bind(projectController)
);

// Delete project
router.delete('/:id',
  authenticate,
  projectController.deleteProject.bind(projectController)
);

export { router as projectRouter }; 