import * as path from 'path';
import * as fs from 'fs/promises';

interface Workspace {
  id: string;
  name: string;
  repository: string;
  path: string;
  createdAt: Date;
  updatedAt: Date;
}

interface WorkspaceConfig {
  name: string;
  repository: string;
}

export class WorkspaceService {
  private workspacesRoot: string;

  constructor() {
    this.workspacesRoot = process.env.WORKSPACE_ROOT || '/tmp/lightci/workspaces';
  }

  async createWorkspace(config: WorkspaceConfig): Promise<Workspace> {
    try {
      // Create unique workspace ID
      const workspaceId = `ws-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
      const workspacePath = path.join(this.workspacesRoot, workspaceId);

      console.log(`[WorkspaceService] Creating workspace:`, {
        workspaceId,
        workspacePath,
        config
      });

      // Ensure workspaces root exists with proper permissions
      try {
        await fs.access(this.workspacesRoot, fs.constants.W_OK);
        console.log(`[WorkspaceService] Workspace root ${this.workspacesRoot} exists and is writable`);
      } catch {
        console.log(`[WorkspaceService] Creating workspace root directory ${this.workspacesRoot}`);
        await fs.mkdir(this.workspacesRoot, { recursive: true, mode: 0o755 });
      }

      // Create workspace directory with proper permissions
      console.log(`[WorkspaceService] Creating workspace directory ${workspacePath}`);
      await fs.mkdir(workspacePath, { recursive: true, mode: 0o755 });

      // Ensure the directory is writable
      try {
        await fs.access(workspacePath, fs.constants.W_OK);
        console.log(`[WorkspaceService] Workspace directory ${workspacePath} is writable`);
      } catch (error: unknown) {
        console.error(`[WorkspaceService] Failed to access workspace directory ${workspacePath}:`, error);
        throw new Error(`Failed to access workspace directory: ${error instanceof Error ? error.message : String(error)}`);
      }

      const workspace = {
        id: workspaceId,
        name: config.name,
        repository: config.repository,
        path: workspacePath,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      console.log(`[WorkspaceService] Successfully created workspace:`, {
        workspaceId,
        workspacePath
      });

      return workspace;
    } catch (error) {
      console.error(`[WorkspaceService] Error creating workspace:`, {
        config,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new Error(`Failed to create workspace: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const workspacePath = path.join(this.workspacesRoot, id);
    
    try {
      await fs.access(workspacePath);
      console.log(`[WorkspaceService] Found workspace:`, {
        id,
        workspacePath
      });
      return {
        id,
        name: id, // We don't store workspace metadata currently
        repository: '', // We don't store workspace metadata currently
        path: workspacePath,
        createdAt: new Date(0), // We don't store workspace metadata currently
        updatedAt: new Date(0) // We don't store workspace metadata currently
      };
    } catch (error) {
      console.log(`[WorkspaceService] Workspace not found:`, {
        id,
        workspacePath,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
      return null;
    }
  }

  async deleteWorkspace(workspace: Workspace): Promise<void> {
    try {
      console.log(`[WorkspaceService] Deleting workspace:`, {
        id: workspace.id,
        path: workspace.path
      });
      await fs.rm(workspace.path, { recursive: true, force: true });
      console.log(`[WorkspaceService] Successfully deleted workspace:`, {
        id: workspace.id,
        path: workspace.path
      });
    } catch (error) {
      console.error(`[WorkspaceService] Error deleting workspace:`, {
        workspace,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new Error(`Failed to delete workspace: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
