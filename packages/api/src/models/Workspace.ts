export interface Workspace {
  id: string;
  name: string;
  repository: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceConfig {
  name: string;
  repository: string;
} 