import { Request, Response } from 'express-serve-static-core';
import { ParamsDictionary } from 'express-serve-static-core';
import { EngineService } from '../services/engine.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import * as path from 'path';
import * as fs from 'fs';
import { Readable } from 'stream';
import { PrismaClient } from '@prisma/client';

interface AuthenticatedRequest extends Request<any, any, any, any> {
  user?: {
    id: string;
  };
}

const prisma = new PrismaClient();

function globToRegExp(pattern: string): RegExp {
  // Process the pattern character by character to build a valid regex
  let result = '^';
  
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const nextChar = i < pattern.length - 1 ? pattern[i + 1] : '';
    
    if (char === '*' && nextChar === '*') {
      // "**" sequence - match any sequence including directory separators
      result += '.*';
      i++; // Skip the next '*'
      
      // If followed by a slash, consume it as part of the ** pattern
      if (i < pattern.length - 1 && pattern[i + 1] === '/') {
        i++; // Skip the slash
      }
    } else if (char === '*') {
      // "*" - match any sequence except directory separators
      result += '[^/]*';
    } else if (char === '?') {
      // "?" - match any single character except directory separators
      result += '[^/]';
    } else if (char === '.') {
      // Escape dot
      result += '\\.';
    } else if ('/+()[]{}^$|\\'.indexOf(char) !== -1) {
      // Escape special regex characters
      result += '\\' + char;
    } else {
      // Regular character
      result += char;
    }
  }
  
  result += '$';
  return new RegExp(result);
}

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

      // Get the pipeline to check artifact patterns
      const pipeline = await this.engineService.getPipeline(build.pipelineId);
      if (!pipeline) {
        throw new NotFoundError('Pipeline not found');
      }

      // Validate against artifact patterns
      const patterns = pipeline.artifactPatterns || [];
      console.log('Validating artifact name:', name);
      console.log('Against patterns:', patterns);
      if (patterns.length > 0) {
        const isAllowed = patterns.some(pattern => {
          try {
            const regex = globToRegExp(pattern);
            console.log('Using regex:', regex);
            const matches = regex.test(name);
            console.log('Pattern', pattern, 'matches:', matches);
            return matches;
          } catch (error) {
            console.warn(`Invalid artifact pattern: ${pattern}`, error);
            return false;
          }
        });

        if (!isAllowed) {
          throw new ValidationError(`File name '${name}' does not match any allowed patterns`);
        }
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
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
      } else if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        console.error('Error uploading artifact:', error);
        res.status(500).json({ error: 'Failed to upload artifact' });
      }
    }
  }

  async deleteArtifact(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const userId = req.user?.id;

      console.log('[ArtifactController] Delete request for artifact ID:', id);
      console.log('[ArtifactController] User ID:', userId);

      if (!userId) {
        console.log('[ArtifactController] No user ID found in request');
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Get the artifact
      const artifact = await this.engineService.getArtifact(id);
      console.log('[ArtifactController] getArtifact result:', artifact);
      
      if (!artifact) {
        console.log('[ArtifactController] Artifact not found');
        return res.status(404).json({ error: 'Artifact not found' });
      }

      // Get the pipeline run and its associated pipeline
      const pipelineRun = await this.engineService.getPipelineRun(artifact.buildId);
      console.log('[ArtifactController] Found pipeline run:', pipelineRun);

      if (!pipelineRun) {
        console.log('[ArtifactController] Pipeline run not found');
        return res.status(404).json({ error: 'Pipeline run not found' });
      }

      // Get the pipeline to check ownership
      const pipeline = await this.engineService.getPipeline(pipelineRun.pipelineId);
      if (!pipeline) {
        console.log('[ArtifactController] Pipeline not found');
        return res.status(404).json({ error: 'Pipeline not found' });
      }

      console.log('[ArtifactController] Pipeline owner ID:', pipeline.createdById);
      console.log('[ArtifactController] Request user ID:', userId);

      // Check if the user has permission to delete this artifact
      if (pipeline.createdById !== userId) {
        console.log('[ArtifactController] Permission denied - user IDs do not match');
        return res.status(403).json({ error: 'Permission denied' });
      }

      // Delete the artifact using the engine service
      console.log('[ArtifactController] Deleting artifact...');
      await this.engineService.deleteArtifact(id);
      console.log('[ArtifactController] Artifact deleted successfully');
      
      return res.status(204).send();
    } catch (error) {
      console.error('[ArtifactController] Error deleting artifact:', error);
      return res.status(500).json({ error: 'Failed to delete artifact' });
    }
  }
}
