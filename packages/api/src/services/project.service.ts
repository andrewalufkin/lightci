import { prisma } from '../lib/prisma';
import { BadRequestError } from '../errors';
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
    ownerId: string;
    ownerType: 'user' | 'organization';
  }) {
    const { ownerId, ownerType, ...rest } = data;
    return prisma.project.create({
      data: {
        id: uuidv4(),
        ...rest,
        owner_id: ownerId,
        owner_type: ownerType,
        updated_at: new Date()
      }
    });
  }

  async getProject(id: string) {
    return prisma.project.findUnique({
      where: { id }
    });
  }

  async updateProject(id: string, data: {
    name?: string;
    description?: string;
  }) {
    return prisma.project.update({
      where: { id },
      data: {
        ...data,
        updated_at: new Date()
      }
    });
  }

  async deleteProject(id: string) {
    return prisma.project.delete({
      where: { id }
    });
  }

  async listProjects(options: {
    ownerId?: string;
    ownerType?: 'user' | 'organization';
    skip?: number;
    take?: number;
  }) {
    const { ownerId, ownerType, ...rest } = options;
    return prisma.project.findMany({
      where: {
        owner_id: ownerId,
        owner_type: ownerType
      },
      ...rest
    });
  }
} 