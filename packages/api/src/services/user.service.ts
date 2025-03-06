import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class UserService {
  async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        accountStatus: true,
        accountTier: true
      }
    });
  }

  async findByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        accountStatus: true,
        accountTier: true,
        passwordHash: true
      }
    });
  }
}

export const userService = new UserService(); 