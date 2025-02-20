import { Request, Response } from 'express';
import { EngineService } from '../services/engine.service';
import { NotFoundError, ValidationError } from '../utils/errors';

export class ArtifactController {
  constructor(private engineService: EngineService) {}

  async downloadArtifact(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const artifact = await this.engineService.getArtifact(id);
      
      if (!artifact) {
        throw new NotFoundError('Artifact not found');
      }

      // In a real implementation, we would stream the file from storage
      // For now, we'll just send the mock data
      const mockContent = `Mock content for artifact ${artifact.name}`;

      res.setHeader('Content-Type', artifact.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.name}"`);
      res.setHeader('Content-Length', mockContent.length);
      
      res.send(mockContent);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to download artifact' });
      }
    }
  }

  async uploadArtifact(req: Request, res: Response) {
    try {
      const { buildId, name, contentType } = req.body;

      if (!buildId || !name) {
        throw new ValidationError('Build ID and artifact name are required');
      }

      // Ensure the build exists
      const build = await this.engineService.getBuild(buildId);
      if (!build) {
        throw new NotFoundError('Build not found');
      }

      // In a real implementation, we would handle file upload and storage
      // For now, we'll just create a mock artifact record
      const artifact = await this.engineService.createArtifact({
        buildId,
        name,
        contentType,
        size: req.body.size || 0,
        metadata: req.body.metadata
      });

      res.status(201).json(artifact);
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
      } else if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to upload artifact' });
      }
    }
  }

  async deleteArtifact(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const artifact = await this.engineService.getArtifact(id);
      
      if (!artifact) {
        throw new NotFoundError('Artifact not found');
      }

      await this.engineService.deleteArtifact(id);
      res.status(204).send();
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to delete artifact' });
      }
    }
  }
}
