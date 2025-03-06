import express from 'express';
import type { Request, Response } from 'express-serve-static-core';
import { ProjectService } from '../services/project.service';
import { ProjectOwnerType, ProjectVisibility, CreateProjectInput, UpdateProjectInput } from '../models/Project';

interface ProjectRequestBody {
  name?: string;
  description?: string;
  visibility?: ProjectVisibility;
  defaultBranch?: string;
  pipelineIds?: string[];
  settings?: Record<string, any>;
}

// Define the shape of our request without extending Express types
interface ProjectRequest {
  body: ProjectRequestBody;
  user?: {
    id: string;
    [key: string]: any;
  };
  params: {
    id?: string;
    [key: string]: string | undefined;
  };
}

interface ProjectParams {
  id: string;
}

interface ProjectResponse {
  id: string;
  name: string;
  description?: string;
  visibility?: ProjectVisibility;
  owner_id: string;
  [key: string]: any;
}

interface RequestWithUser extends Request<ProjectParams, ProjectResponse, ProjectRequestBody> {
  user?: {
    id: string;
    [key: string]: any;
  };
}

export class ProjectController {
  constructor(private projectService: ProjectService) {}

  async createProject(req: Request & ProjectRequest, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!req.body.name) {
        return res.status(400).json({ error: 'Project name is required' });
      }

      const projectData: CreateProjectInput = {
        name: req.body.name,
        description: req.body.description,
        ownerId: req.user.id,
        ownerType: 'user',
        visibility: req.body.visibility,
        pipelineIds: req.body.pipelineIds
      };

      const project = await this.projectService.createProject(projectData);
      return res.status(201).json(project);
    } catch (error: any) {
      if (error.code === 'P2002') {
        return res.status(401).json({ error: 'A project with this name already exists for this owner' });
      }
      if (error.message === 'Invalid owner type') {
        return res.status(400).json({
          error: 'Invalid owner type. Must be either "user" or "organization"'
        });
      }
      if (error.message === 'User not found') {
        return res.status(404).json({ error: 'User not found' });
      }
      if (error.message === 'Organization not found') {
        return res.status(404).json({ error: 'Organization not found' });
      }

      return res.status(500).json({ error: 'Failed to create project' });
    }
  }

  async listProjects(req: Request & ProjectRequest, res: Response): Promise<Response> {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const projects = await this.projectService.listProjects({ ownerId: req.user.id, ownerType: 'user' });
      return res.json(projects);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to list projects' });
    }
  }

  async getProject(req: Request & ProjectRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      const project = await this.projectService.getProject(id);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (project.owner_id !== req.user?.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      return res.json(project);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to get project' });
    }
  }

  async updateProject(req: Request & ProjectRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      const existingProject = await this.projectService.getProject(id);
      if (!existingProject) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (existingProject.owner_id !== req.user?.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const updateData: UpdateProjectInput = {
        name: req.body.name,
        description: req.body.description,
        visibility: req.body.visibility,
        defaultBranch: req.body.defaultBranch,
        pipelineIds: req.body.pipelineIds,
        settings: req.body.settings
      };

      const project = await this.projectService.updateProject(id, updateData);
      return res.json(project);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to update project' });
    }
  }

  async deleteProject(req: Request & ProjectRequest, res: Response): Promise<Response> {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      const existingProject = await this.projectService.getProject(id);
      if (!existingProject) {
        return res.status(404).json({ error: 'Project not found' });
      }

      if (existingProject.owner_id !== req.user?.id) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      await this.projectService.deleteProject(id);
      return res.status(204).send();
    } catch (error) {
      return res.status(500).json({ error: 'Failed to delete project' });
    }
  }
} 