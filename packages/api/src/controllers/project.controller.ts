import { Request, Response } from 'express';
import { ProjectService } from '../services/project.service';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

export class ProjectController {
  constructor(private projectService: ProjectService) {}

  async createProject(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      console.log('Creating project with data:', {
        body: req.body,
        userId,
        user: req.user
      });

      // Use the project service to create the project
      const project = await this.projectService.createProject({
        ...req.body,
        ownerId: userId,
        ownerType: 'user'
      });

      res.status(201).json(project);
    } catch (error) {
      console.error('Error creating project:', error);
      
      if (error instanceof PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          res.status(400).json({ error: 'A project with this name already exists for this owner' });
          return;
        } else if (error.code === 'P2003') {
          res.status(400).json({ 
            error: 'Invalid owner reference. This could mean the user account is not properly set up.',
            details: error.meta
          });
          return;
        }
      }
      
      if (error instanceof Error) {
        if (error.message === 'User not found') {
          res.status(404).json({ error: 'User not found' });
          return;
        } else if (error.message === 'Organization not found') {
          res.status(404).json({ error: 'Organization not found' });
          return;
        }
      }

      res.status(500).json({ error: 'Failed to create project' });
    }
  }

  async listProjects(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const projects = await this.projectService.listProjects(userId, 'user');
      res.json(projects);
    } catch (error) {
      console.error('Error listing projects:', error);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  }

  async getProject(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const project = await this.projectService.getProject(id);

      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Check if user has access to this project
      if (project.ownerId !== req.user?.id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      res.json(project);
    } catch (error) {
      console.error('Error getting project:', error);
      res.status(500).json({ error: 'Failed to get project' });
    }
  }

  async updateProject(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const existingProject = await this.projectService.getProject(id);

      if (!existingProject) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Check if user has access to this project
      if (existingProject.ownerId !== req.user?.id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const project = await this.projectService.updateProject(id, req.body);
      res.json(project);
    } catch (error) {
      console.error('Error updating project:', error);
      res.status(500).json({ error: 'Failed to update project' });
    }
  }

  async deleteProject(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const existingProject = await this.projectService.getProject(id);

      if (!existingProject) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }

      // Check if user has access to this project
      if (existingProject.ownerId !== req.user?.id) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      await this.projectService.deleteProject(id);
      res.status(204).send();
    } catch (error) {
      console.error('Error deleting project:', error);
      res.status(500).json({ error: 'Failed to delete project' });
    }
  }
} 