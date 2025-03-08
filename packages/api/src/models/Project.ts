import type { ProjectVisibility } from '../services/project.service';

export interface Project {
  id: string;
  name: string;
  description?: string;
  created_at: Date;
  updated_at: Date;
  default_branch?: string;
  last_build_at?: Date;
  settings?: Record<string, any>;
  visibility: ProjectVisibility;
  status: string;
  userOwners?: {
    user: {
      id: string;
      email: string;
      username?: string;
    };
  }[];
  orgOwners?: {
    organization: {
      id: string;
      name: string;
      slug: string;
    };
  }[];
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  userId?: string;
  organizationId?: string;
  visibility?: ProjectVisibility;
  defaultBranch?: string;
  pipelineIds?: string[];
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  visibility?: ProjectVisibility;
  defaultBranch?: string;
  settings?: Record<string, any>;
} 