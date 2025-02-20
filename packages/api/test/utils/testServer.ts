import express from 'express';
import { Server } from 'http';
import { pipelineRouter } from '../../src/routes/pipelines';
import { buildRouter } from '../../src/routes/builds';
import { artifactRouter } from '../../src/routes/artifacts';
import { webhookRouter } from '../../src/routes/webhooks';
import { AuthenticationError, NotFoundError, ValidationError } from '../../src/utils/errors';
import { EngineService } from '../../src/services/engine.service';
import { WorkspaceService } from '../../src/services/workspace.service';
import { PipelineController } from '../../src/controllers/pipeline.controller';
import { BuildController } from '../../src/controllers/build.controller';
import { ArtifactController } from '../../src/controllers/artifact.controller';
import { WebhookController } from '../../src/controllers/webhook.controller';
import { mockEngineService, mockWorkspaceService } from './mockServices';
import { authenticate } from '../../src/middleware/auth';

class TestServer {
  private app: express.Application;
  private server: Server | null = null;

  constructor() {
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private setupRoutes() {
    // Initialize services and controllers with mocks
    const engineService = mockEngineService;
    const workspaceService = mockWorkspaceService;
    const pipelineController = new PipelineController(engineService, workspaceService);
    const buildController = new BuildController(engineService);
    const artifactController = new ArtifactController(engineService);
    const webhookController = new WebhookController(engineService);

    // Set up pipeline routes with authentication
    this.app.use('/api/pipelines', authenticate);
    this.app.get('/api/pipelines', pipelineController.listPipelines.bind(pipelineController));
    this.app.post('/api/pipelines', pipelineController.createPipeline.bind(pipelineController));
    this.app.get('/api/pipelines/:id', pipelineController.getPipeline.bind(pipelineController));
    this.app.put('/api/pipelines/:id', pipelineController.updatePipeline.bind(pipelineController));
    this.app.delete('/api/pipelines/:id', pipelineController.deletePipeline.bind(pipelineController));
    this.app.post('/api/pipelines/:id/trigger', pipelineController.triggerPipeline.bind(pipelineController));

    // Set up build routes with authentication
    this.app.use('/api/builds', authenticate);
    this.app.get('/api/builds', buildController.listBuilds.bind(buildController));
    this.app.get('/api/builds/:id', buildController.getBuild.bind(buildController));
    this.app.post('/api/builds/:id/cancel', buildController.cancelBuild.bind(buildController));
    this.app.get('/api/builds/:id/logs', buildController.getBuildLogs.bind(buildController));
    this.app.get('/api/builds/:id/artifacts', buildController.getBuildArtifacts.bind(buildController));

    // Set up artifact routes with authentication
    this.app.use('/api/artifacts', authenticate);
    this.app.get('/api/artifacts/:id', artifactController.downloadArtifact.bind(artifactController));
    this.app.post('/api/artifacts', artifactController.uploadArtifact.bind(artifactController));
    this.app.delete('/api/artifacts/:id', artifactController.deleteArtifact.bind(artifactController));

    // Set up webhook routes (no authentication required)
    this.app.post('/api/webhooks/github', webhookController.handleGitHubWebhook.bind(webhookController));
    this.app.post('/api/webhooks/gitlab', webhookController.handleGitLabWebhook.bind(webhookController));
  }

  private setupErrorHandling() {
    // Error handling middleware
    this.app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message });
      }
      if (err instanceof AuthenticationError) {
        return res.status(401).json({ error: err.message });
      }
      if (err instanceof NotFoundError) {
        return res.status(404).json({ error: err.message });
      }
      
      console.error('Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  async start(port: number = 3001) {
    return new Promise<void>((resolve) => {
      this.server = this.app.listen(port, () => {
        resolve();
      });
    });
  }

  async stop() {
    return new Promise<void>((resolve, reject) => {
      if (this.server) {
        this.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async reset() {
    // Reset any test state here
  }

  getApp() {
    return this.app;
  }
}

export const testServer = new TestServer();
