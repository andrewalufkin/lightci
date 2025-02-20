// packages/api/src/config/database.ts

import { PrismaClient } from '@prisma/client'
import { Config } from './config'

export class DatabaseService {
  private static instance: DatabaseService
  private prisma: PrismaClient

  private constructor() {
    this.prisma = new PrismaClient({
      log: Config.isDevelopment() ? ['query', 'error', 'warn'] : ['error'],
      datasourceUrl: Config.getDatabaseUrl(),
    })
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService()
    }
    return DatabaseService.instance
  }

  public getClient(): PrismaClient {
    return this.prisma
  }

  public async healthCheck(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`
      return true
    } catch (error) {
      console.error('Database health check failed:', error)
      return false
    }
  }

  public async disconnect(): Promise<void> {
    await this.prisma.$disconnect()
  }
}