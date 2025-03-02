import { PrismaClient, Project, Prisma } from '@prisma/client';
import { BadRequestError } from '../errors';
import { v4 as uuidv4 } from 'uuid';

// Define type-safe enums for project fields
export const ProjectOwnerType = {
  USER: 'user',
  ORGANIZATION: 'organization'
} as const;

export const ProjectVisibility = {
  PUBLIC: 'public',
  PRIVATE: 'private'
} as const;

export const ProjectStatus = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  DELETED: 'deleted'
} as const;

export type ProjectOwnerType = typeof ProjectOwnerType[keyof typeof ProjectOwnerType];
export type ProjectVisibility = typeof ProjectVisibility[keyof typeof ProjectVisibility];
export type ProjectStatus = typeof ProjectStatus[keyof typeof ProjectStatus];

export class ProjectService {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }
  async createProject(
    {
      name,
      description,
      ownerId,
      ownerType,
      visibility = ProjectVisibility.PRIVATE,
      pipelineIds,
    }: {
      name: string;
      description?: string;
      ownerId: string;
      ownerType: ProjectOwnerType;
      visibility?: ProjectVisibility;
      pipelineIds?: string[];
    }
  ): Promise<Project> {
    // Validate owner exists
    if (ownerType === ProjectOwnerType.USER) {
      const user = await this.prisma.user.findUnique({ where: { id: ownerId } });
      if (!user) {
        throw new BadRequestError('User not found');
      }
    } else if (ownerType === ProjectOwnerType.ORGANIZATION) {
      const org = await this.prisma.organization.findUnique({ where: { id: ownerId } });
      if (!org) {
        throw new BadRequestError('Organization not found');
      }
    } else {
      throw new BadRequestError('Invalid owner type');
    }
  
    // Create the project
    const now = new Date();
    const projectId = uuidv4();
    
    // Insert the project directly using SQL to avoid Prisma's type checking issues
    await this.prisma.$executeRaw`
      INSERT INTO projects (
        id, name, description, owner_id, owner_type, 
        created_at, updated_at, status, visibility
      ) VALUES (
        ${projectId}, ${name}, ${description || ""}, ${ownerId}, ${ownerType}, 
        ${now}, ${now}, ${ProjectStatus.ACTIVE}, ${visibility}
      )
    `;
    
    // Add pipelines if needed
    if (pipelineIds && pipelineIds.length > 0) {
      await this.prisma.pipeline.updateMany({
        where: {
          id: {
            in: pipelineIds
          }
        },
        data: {
          projectId
        }
      });
    }
    
    // Return the project with pipelines
    return this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        pipelines: true
      }
    }) as Promise<Project>;
  }
  
  async listProjects(ownerId: string, ownerType: string): Promise<Project[]> {
    // Use raw SQL to query projects
    const projects = await this.prisma.$queryRaw<Project[]>`
      SELECT p.* 
      FROM projects p
      WHERE p.owner_id = ${ownerId} AND p.owner_type = ${ownerType}
    `;
    
    // Fetch pipelines for each project
    const projectsWithPipelines = await Promise.all(
      projects.map(async (project) => {
        const pipelines = await this.prisma.pipeline.findMany({
          where: { projectId: project.id }
        });
        return { ...project, pipelines };
      })
    );
    
    return projectsWithPipelines as Project[];
  }

  async getProject(id: string): Promise<Project | null> {
    return this.prisma.project.findUnique({
      where: { id },
      include: {
        pipelines: true
      }
    });
  }

  async updateProject(id: string, data: {
    name?: string;
    description?: string;
    visibility?: string;
    defaultBranch?: string;
    pipelineIds?: string[];
    settings?: Record<string, any>;
  }): Promise<Project> {
    const { pipelineIds, defaultBranch, ...projectData } = data;

    const updateData: any = {
      ...projectData,
      updated_at: new Date()
    };
    
    if (defaultBranch) {
      updateData.default_branch = defaultBranch;
    }

    // Update the project
    const project = await this.prisma.project.update({
      where: { id },
      data: updateData
    });

    // Update pipeline associations if needed
    if (pipelineIds) {
      // First, disconnect all existing pipelines
      await this.prisma.pipeline.updateMany({
        where: {
          projectId: id
        },
        data: {
          projectId: null
        }
      });

      // Then connect the new ones
      if (pipelineIds.length > 0) {
        await this.prisma.pipeline.updateMany({
          where: {
            id: {
              in: pipelineIds
            }
          },
          data: {
            projectId: id
          }
        });
      }
    }

    // Return the updated project with pipelines
    return this.prisma.project.findUnique({
      where: { id },
      include: {
        pipelines: true
      }
    }) as Promise<Project>;
  }

  async deleteProject(id: string): Promise<Project> {
    return this.prisma.project.delete({
      where: { id }
    });
  }
} 