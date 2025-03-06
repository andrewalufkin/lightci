import { Request, Response } from 'express-serve-static-core';
import { ParamsDictionary } from 'express-serve-static-core';
import { EngineService } from '../services/engine.service';
import { NotFoundError, ValidationError } from '../utils/errors';
import * as path from 'path';
import * as fs from 'fs';
import { Readable } from 'stream';

interface ArtifactUploadBody {
  buildId: string;
  name: string;
  contentType?: string;
  size?: number;
  metadata?: any;
}

interface ArtifactParams {
  id: string;
}

export class ArtifactController {
  constructor(private engineService: EngineService) {}

  async downloadArtifact(req: Request<ArtifactParams>, res: Response) {
    try {
      const { id } = req.params;
      console.log(`[ArtifactController] Download request for artifact ID: ${id}`);
      
      const artifact = await this.engineService.getArtifact(id);
      console.log(`[ArtifactController] getArtifact result:`, artifact);
      
      if (!artifact) {
        console.log(`[ArtifactController] Artifact not found for ID: ${id}`);
        throw new NotFoundError('Artifact not found');
      }

      // Get the pipeline run to access the artifacts path
      const run = await this.engineService.getPipelineRun(artifact.buildId);
      console.log(`[ArtifactController] getPipelineRun result:`, run);
      
      if (!run || !run.artifactsCollected) {
        console.log(`[ArtifactController] Run not found or artifacts not collected. Run:`, run);
        throw new NotFoundError('Artifact path not found');
      }

      // Get the artifacts base directory
      const artifactsBaseDir = process.env.ARTIFACTS_ROOT || '/tmp/lightci/artifacts';
      console.log(`[ArtifactController] Using artifacts base directory: ${artifactsBaseDir}`);

      // Ensure we have the full absolute path
      const artifactsPath = run.artifactsPath && path.isAbsolute(run.artifactsPath)
        ? run.artifactsPath
        : path.join(artifactsBaseDir, artifact.buildId);
      console.log(`[ArtifactController] Resolved artifacts path: ${artifactsPath}`);

      const filePath = path.join(artifactsPath, artifact.path);
      console.log(`[ArtifactController] Full file path: ${filePath}`);

      // Check if file exists
      const fileExists = fs.existsSync(filePath);
      console.log(`[ArtifactController] File exists at ${filePath}: ${fileExists}`);
      
      if (!fileExists) {
        throw new NotFoundError('Artifact file not found');
      }

      // Set appropriate headers
      res.setHeader('Content-Type', artifact.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${artifact.name}"`);
      console.log(`[ArtifactController] Set headers for file: ${artifact.name}, type: ${artifact.contentType || 'application/octet-stream'}`);

      // Stream the file
      console.log(`[ArtifactController] Starting to stream file: ${filePath}`);
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      // Handle errors during streaming
      fileStream.on('error', (error) => {
        console.error('[ArtifactController] Error streaming artifact file:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to download artifact' });
        }
      });

      // Log when the stream finishes
      fileStream.on('end', () => {
        console.log(`[ArtifactController] Successfully completed streaming file: ${filePath}`);
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        console.log(`[ArtifactController] NotFoundError:`, error.message);
        res.status(404).json({ error: error.message });
      } else {
        console.error('[ArtifactController] Error downloading artifact:', error);
        res.status(500).json({ error: 'Failed to download artifact' });
      }
    }
  }

  async uploadArtifact(req: Request<{}, any, ArtifactUploadBody>, res: Response) {
    try {
      const { buildId, name, contentType } = req.body;

      if (!buildId || !name) {
        throw new Error('Missing required fields: buildId and name');
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
        contentType: contentType || 'application/octet-stream',
        size: req.body.size || 0,
        metadata: req.body.metadata
      });

      res.status(201).json(artifact);
    } catch (error: any) {
      if (error.message.includes('validation')) {
        res.status(400).json({ error: error.message });
      } else if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        console.error('Error uploading artifact:', error);
        res.status(500).json({ error: 'Failed to upload artifact' });
      }
    }
  }

  async deleteArtifact(req: Request<{ id: string }>, res: Response) {
    try {
      const { id } = req.params;
      await this.engineService.deleteArtifact(id);
      res.status(204).send();
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        console.error('Error deleting artifact:', error);
        res.status(500).json({ error: 'Failed to delete artifact' });
      }
    }
  }
}
