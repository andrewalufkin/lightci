import { prisma } from '../lib/prisma.js';
import { BadRequestError } from '../errors.js';
import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@prisma/client';

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
  async createProject(data: {
    name: string;
    description?: string;
    userId?: string;
    organizationId?: string;
    visibility?: ProjectVisibility;
    defaultBranch?: string;
    pipelineIds?: string[];
  }) {
    const { userId, organizationId, defaultBranch, ...rest } = data;
    
    if (!userId && !organizationId) {
      throw new BadRequestError('Either userId or organizationId must be provided');
    }

    const projectId = uuidv4();
    
    return prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          id: projectId,
          ...rest,
          default_branch: defaultBranch,
          updated_at: new Date()
        }
      });

      if (userId) {
        await tx.userProject.create({
          data: {
            user_id: userId,
            project_id: projectId
          }
        });
      }

      if (organizationId) {
        await tx.orgProject.create({
          data: {
            org_id: organizationId,
            project_id: projectId
          }
        });
      }

      return project;
    });
  }

  async getProject(id: string) {
    return prisma.project.findUnique({
      where: { id },
      include: {
        userOwners: {
          include: {
            user: true
          }
        },
        orgOwners: {
          include: {
            organization: true
          }
        }
      }
    });
  }

  async updateProject(id: string, data: {
    name?: string;
    description?: string;
    visibility?: ProjectVisibility;
    defaultBranch?: string;
    settings?: Record<string, any>;
  }) {
    return prisma.project.update({
      where: { id },
      data: {
        ...data,
        default_branch: data.defaultBranch,
        updated_at: new Date()
      }
    });
  }

  async deleteProject(id: string) {
    return prisma.$transaction(async (tx) => {
      // Delete associated records first
      await tx.userProject.deleteMany({
        where: { project_id: id }
      });
      
      await tx.orgProject.deleteMany({
        where: { project_id: id }
      });

      return tx.project.delete({
        where: { id }
      });
    });
  }

  async listProjects(options: {
    userId?: string;
    organizationId?: string;
    skip?: number;
    take?: number;
  }) {
    const { userId, organizationId, ...rest } = options;
    
    if (!userId && !organizationId) {
      throw new BadRequestError('Either userId or organizationId must be provided');
    }

    return prisma.project.findMany({
      where: {
        OR: [
          userId ? {
            userOwners: {
              some: {
                user_id: userId
              }
            }
          } : {},
          organizationId ? {
            orgOwners: {
              some: {
                org_id: organizationId
              }
            }
          } : {}
        ]
      },
      include: {
        userOwners: {
          include: {
            user: true
          }
        },
        orgOwners: {
          include: {
            organization: true
          }
        }
      },
      ...rest
    });
  }

  async isUserProjectOwner(projectId: string, userId: string): Promise<boolean> {
    const count = await prisma.userProject.count({
      where: {
        project_id: projectId,
        user_id: userId
      }
    });
    return count > 0;
  }

  async isOrganizationProjectOwner(projectId: string, organizationId: string): Promise<boolean> {
    const count = await prisma.orgProject.count({
      where: {
        project_id: projectId,
        org_id: organizationId
      }
    });
    return count > 0;
  }
} 