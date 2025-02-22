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

      // Ensure workspaces root exists
      await fs.mkdir(this.workspacesRoot, { recursive: true });

      // Create workspace directory
      await fs.mkdir(workspacePath, { recursive: true });

      const workspace = {
        id: workspaceId,
        name: config.name,
        repository: config.repository,
        path: workspacePath,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      return workspace;
    } catch (error) {
      console.error('[WorkspaceService] Error creating workspace:', error);
      throw new Error('Failed to create workspace');
    }
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const workspacePath = path.join(this.workspacesRoot, id);
    
    try {
      await fs.access(workspacePath);
      return {
        id,
        name: id, // We don't store workspace metadata currently
        repository: '', // We don't store workspace metadata currently
        path: workspacePath,
        createdAt: new Date(0), // We don't store workspace metadata currently
        updatedAt: new Date(0) // We don't store workspace metadata currently
      };
    } catch {
      return null;
    }
  }

  async deleteWorkspace(workspace: Workspace): Promise<void> {
    try {
      await fs.rm(workspace.path, { recursive: true, force: true });
    } catch (error) {
      console.error('[WorkspaceService] Error deleting workspace:', error);
      throw new Error('Failed to delete workspace');
    }
  }
}
