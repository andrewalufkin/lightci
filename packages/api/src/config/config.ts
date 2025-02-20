import * as dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 3000,
  database: {
    url: process.env.DATABASE_URL,
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret-key',
    expiresIn: '24h',
  },
  engine: {
    url: process.env.CORE_ENGINE_URL || 'localhost:50051',
  },
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'x-api-key'],
  },
};

export class Config {
  private static instance: Config;

  private constructor() {
    // Load environment variables or configuration files
  }

  public static isDevelopment(): boolean {
    return process.env.NODE_ENV === 'development';
  }

  public static getDatabaseUrl(): string {
    return process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/lightci_dev?schema=public';
  }
} 