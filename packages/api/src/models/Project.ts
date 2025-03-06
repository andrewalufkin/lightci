export type ProjectOwnerType = 'user' | 'organization';
export type ProjectVisibility = 'public' | 'private';

export interface Project {
  id: string;
  name: string;
  description?: string;
  owner_id: string;
  owner_type: ProjectOwnerType;
  created_at: Date;
  updated_at: Date;
  default_branch?: string;
  last_build_at?: Date;
  settings?: Record<string, any>;
  visibility: ProjectVisibility;
  status: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  ownerId: string;
  ownerType: ProjectOwnerType;
  visibility?: ProjectVisibility;
  pipelineIds?: string[];
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  visibility?: ProjectVisibility;
  defaultBranch?: string;
  pipelineIds?: string[];
  settings?: Record<string, any>;
} 