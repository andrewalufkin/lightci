import { Router } from 'express';
import { BuildController } from '../controllers/build.controller';
import { EngineService } from '../services/engine.service';
import { authenticate } from '../middleware/auth';
import { WebSocket } from 'ws';
import { Server } from 'http';

const router = Router();
const engineService = new EngineService(process.env.CORE_ENGINE_URL || 'localhost:50051');
const buildController = new BuildController(engineService);

// Store active WebSocket connections for each build
const buildConnections = new Map<string, Set<WebSocket>>();

export const setupWebSocket = (server: Server) => {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;
    const buildIdMatch = pathname.match(/\/builds\/([^\/]+)\/status/);

    if (buildIdMatch) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const buildId = buildIdMatch[1];
        
        // Add connection to the set for this build
        if (!buildConnections.has(buildId)) {
          buildConnections.set(buildId, new Set());
        }
        buildConnections.get(buildId)!.add(ws);

        ws.on('close', () => {
          // Remove connection when closed
          buildConnections.get(buildId)?.delete(ws);
          if (buildConnections.get(buildId)?.size === 0) {
            buildConnections.delete(buildId);
          }
        });
      });
    }
  });
};

// Function to broadcast status updates to all connected clients for a build
export const broadcastBuildUpdate = (buildId: string, update: any) => {
  const connections = buildConnections.get(buildId);
  if (connections) {
    const message = JSON.stringify(update);
    connections.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
};

// List all builds
router.get('/', 
  authenticate,
  buildController.listBuilds.bind(buildController)
);

// Get build details
router.get('/:id',
  authenticate,
  buildController.getBuild.bind(buildController)
);

// Cancel running build
router.post('/:id/cancel',
  authenticate,
  buildController.cancelBuild.bind(buildController)
);

// Stream build logs
router.get('/:id/logs',
  authenticate,
  buildController.getBuildLogs.bind(buildController)
);

// List build artifacts
router.get('/:id/artifacts',
  authenticate,
  buildController.getBuildArtifacts.bind(buildController)
);

export { router as buildRouter };
