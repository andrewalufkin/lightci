import { Router } from 'express';
import { ArtifactController } from '../controllers/artifact.controller';
import { EngineService } from '../services/engine.service';
import { authenticate } from '../middleware/auth';
import { validateSchema } from '../middleware/validation';

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
  authenticate,
  artifactController.downloadArtifact.bind(artifactController)
);

// Upload artifact
router.post('/',
  authenticate,
  validateSchema(artifactUploadSchema),
  artifactController.uploadArtifact.bind(artifactController)
);

// Delete artifact
router.delete('/:id',
  authenticate,
  artifactController.deleteArtifact.bind(artifactController)
);

export { router as artifactRouter };
