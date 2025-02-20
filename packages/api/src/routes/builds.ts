import { Router } from 'express';
import { BuildController } from '../controllers/build.controller';
import { EngineService } from '../services/engine.service';
import { authenticate } from '../middleware/auth';
import { WebSocket } from 'ws';
import { Server } from 'http';

export class BuildRouter {
  private router: Router;
  private engineService: EngineService;
  private buildController: BuildController;
  private buildConnections: Map<string, Set<WebSocket>>;

  constructor(engineService: EngineService) {
    this.router = Router();
    this.engineService = engineService;
    this.buildController = new BuildController(this.engineService);
    this.buildConnections = new Map();
    this.setupRoutes();
  }

  private setupRoutes() {
    // List all builds
    this.router.get('/', 
      authenticate,
      this.buildController.listBuilds.bind(this.buildController)
    );

    // Get build details
    this.router.get('/:id',
      authenticate,
      this.buildController.getBuild.bind(this.buildController)
    );

    // Cancel running build
    this.router.post('/:id/cancel',
      authenticate,
      this.buildController.cancelBuild.bind(this.buildController)
    );

    // Stream build logs
    this.router.get('/:id/logs',
      authenticate,
      this.buildController.getBuildLogs.bind(this.buildController)
    );

    // List build artifacts
    this.router.get('/:id/artifacts',
      authenticate,
      this.buildController.getBuildArtifacts.bind(this.buildController)
    );
  }

  setupWebSocket(server: Server) {
    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;
      const buildIdMatch = pathname.match(/\/builds\/([^\/]+)\/status/);

      if (buildIdMatch) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          const buildId = buildIdMatch[1];
          
          // Add connection to the set for this build
          if (!this.buildConnections.has(buildId)) {
            this.buildConnections.set(buildId, new Set());
          }
          this.buildConnections.get(buildId)!.add(ws);

          ws.on('close', () => {
            // Remove connection when closed
            this.buildConnections.get(buildId)?.delete(ws);
            if (this.buildConnections.get(buildId)?.size === 0) {
              this.buildConnections.delete(buildId);
            }
          });
        });
      }
    });
  }

  broadcastBuildUpdate(buildId: string, update: any) {
    const connections = this.buildConnections.get(buildId);
    if (connections) {
      const message = JSON.stringify(update);
      connections.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  }

  getRouter() {
    return this.router;
  }
}

// Create service and router instances
const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'localhost:50051');
const routerInstance = new BuildRouter(engineService);

// Export what's needed
export const buildRouter = routerInstance.getRouter();
export const setupWebSocket = routerInstance.setupWebSocket.bind(routerInstance);
export const broadcastBuildUpdate = routerInstance.broadcastBuildUpdate.bind(routerInstance);
