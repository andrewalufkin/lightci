import { Router } from 'express';
import { Request, Response, NextFunction, RequestHandler } from 'express-serve-static-core';
import { ArtifactController } from '../controllers/artifact.controller';
import { EngineService } from '../services/engine.service';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import { validateSchema } from '../middleware/validation';

interface ArtifactParams {
  id: string;
}

interface ArtifactUploadBody {
  buildId: string;
  name: string;
  contentType?: string;
  size?: number;
  metadata?: Record<string, string>;
}

const router = Router();
const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3001');
const artifactController = new ArtifactController(engineService);

// Artifact upload schema validation
const artifactUploadSchema = {
  type: 'object',
  required: ['buildId', 'name'],
  properties: {
    buildId: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    contentType: { type: 'string' },
    size: { type: 'number', minimum: 0 },
    metadata: {
      type: 'object',
      additionalProperties: { type: 'string' }
    }
  }
};

// Download artifact
router.get('/:id',
  authenticate as RequestHandler,
  artifactController.downloadArtifact.bind(artifactController) as unknown as RequestHandler
);

// Upload artifact
router.post('/',
  authenticate as RequestHandler,
  validateSchema(artifactUploadSchema),
  artifactController.uploadArtifact.bind(artifactController) as unknown as RequestHandler
);

// Delete artifact
router.delete('/:id',
  authenticate as RequestHandler,
  artifactController.deleteArtifact.bind(artifactController) as unknown as RequestHandler
);

export { router as artifactRouter };
