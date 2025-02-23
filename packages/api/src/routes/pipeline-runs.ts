import { Router } from 'express';
import { PipelineRunController } from '../controllers/pipeline-run.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
const pipelineRunController = new PipelineRunController();

// List all pipeline runs
router.get('/', 
  authenticate,
  pipelineRunController.listRuns.bind(pipelineRunController)
);

// Get pipeline run details
router.get('/:id',
  authenticate,
  pipelineRunController.getRun.bind(pipelineRunController)
);

// Delete pipeline run
router.delete('/:id',
  authenticate,
  pipelineRunController.deleteRun.bind(pipelineRunController)
);

// Get pipeline run artifacts
router.get('/:id/artifacts',
  authenticate,
  pipelineRunController.getRunArtifacts.bind(pipelineRunController)
);

export const pipelineRunRouter = router; 