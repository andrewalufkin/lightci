import { Router } from 'express';
import { Request as ExpressRequest, Response as ExpressResponse } from 'express-serve-static-core';
import { PipelineRunController, TypedRequest, ListRequest } from '../controllers/pipeline-run.controller';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { RequestHandler } from 'express-serve-static-core';

const router = Router();
const pipelineRunController = new PipelineRunController();

// Type assertion for the authenticate middleware
const typedAuthenticate = authenticate as RequestHandler;

// List all pipeline runs
router.get('/', 
  typedAuthenticate,
  async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    await pipelineRunController.listRuns(req as unknown as ListRequest, res);
  }
);

// Get pipeline run details
router.get('/:id',
  typedAuthenticate,
  async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "Missing required parameter: id" });
      return;
    }
    const typedReq = req as unknown as TypedRequest;
    typedReq.params = { id };
    await pipelineRunController.getRun(typedReq, res);
  }
);

// Delete pipeline run
router.delete('/:id',
  typedAuthenticate,
  async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "Missing required parameter: id" });
      return;
    }
    const typedReq = req as unknown as TypedRequest;
    typedReq.params = { id };
    await pipelineRunController.deleteRun(typedReq, res);
  }
);

// Get pipeline run artifacts
router.get('/:id/artifacts',
  typedAuthenticate,
  async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "Missing required parameter: id" });
      return;
    }
    const typedReq = req as unknown as TypedRequest;
    typedReq.params = { id };
    await pipelineRunController.getRunArtifacts(typedReq, res);
  }
);

// Update pipeline run status
router.put('/:id/status',
  typedAuthenticate,
  async (req: ExpressRequest, res: ExpressResponse): Promise<void> => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "Missing required parameter: id" });
      return;
    }
    const typedReq = req as unknown as TypedRequest;
    typedReq.params = { id };
    await pipelineRunController.updateRunStatus(typedReq, res);
  }
);

export { router as pipelineRunRouter }; 