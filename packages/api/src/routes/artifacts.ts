import { Router } from 'express';
import { Request, Response, NextFunction, RequestHandler } from 'express-serve-static-core';
import { ArtifactController } from '../controllers/artifact.controller.js';
import { EngineService } from '../services/engine.service.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { validateSchema } from '../middleware/validation.js';

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

// Artifact upload schema validation
const artifactUploadSchema = {
  type: 'object',
  required: ['buildId', 'name'],
  properties: {
    buildId: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    contentType: { type: 'string' },
    size: { type: 'number', minimum: 0, maximum: 100 * 1024 * 1024 }, // 100MB max
    metadata: {
      type: 'object',
      additionalProperties: { type: 'string' }
    }
  }
};

export function createArtifactRouter(engineService: EngineService) {
  const router = Router();
  const artifactController = new ArtifactController(engineService);

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

  return router;
}
