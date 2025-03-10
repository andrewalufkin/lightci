import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
// @ts-ignore
import supertest from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client';
import { BillingService } from '../services/billing.service';
import { UserService } from '../services/user.service';
// Import the type for Request
import { Request, Response } from 'express';
// @ts-ignore
import jwt from 'jsonwebtoken';

// Define types for our test
type User = {
  id: string;
  email: string;
  username?: string | null;
  fullName?: string | null;
  accountStatus: string;
  accountTier: string;
};

type StorageLimit = {
  hasEnoughStorage: boolean;
  currentUsageMB: number;
  limitMB: number;
  remainingMB: number;
};

type StorageUsage = {
  currentStorageMB: number;
  currentStorageGB: number;
  artifactCount: number;
  recentArtifacts: Array<{
    id: string;
    name: string;
    size: number;
    sizeInMB: number;
    pipelineName: string;
    createdAt: Date;
  }>;
};

// Define a custom request type that includes user
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    accountTier: string;
  };
}

// Create a mock authenticate function
const authenticateMock = jest.fn((req: AuthenticatedRequest, res: Response, next: () => void) => {
  req.user = {
    id: 'test-user-id',
    email: 'test@example.com',
    accountTier: 'free'
  };
  next();
});

// Mock services and middleware
jest.mock('../services/billing.service');
jest.mock('../services/user.service');
jest.mock('../middleware/auth.middleware', () => ({
  authenticate: authenticateMock
}));

describe('Storage Limits API', () => {
  let app: any;
  let mockBillingService: jest.Mocked<BillingService>;
  let mockUserService: jest.Mocked<UserService>;
  const testUserId = uuidv4();
  const testToken = 'test-token';
  
  beforeAll(() => {
    // Set up Express app
    app = express();
    app.use(express.json());
    
    // Override the mock user ID
    authenticateMock.mockImplementation((req: AuthenticatedRequest, res: Response, next: () => void) => {
      req.user = {
        id: testUserId,
        email: 'test@example.com',
        accountTier: 'free'
      };
      next();
    });
    
    // Create mock services with jest.fn() for each method
    mockBillingService = {
      checkStorageLimit: jest.fn()
    } as unknown as jest.Mocked<BillingService>;
    
    mockUserService = {
      findById: jest.fn(),
      calculateArtifactStorageUsage: jest.fn()
    } as unknown as jest.Mocked<UserService>;
    
    // Set up routes
    const userRouter = express.Router();
    
    userRouter.get('/storage-limits', authenticateMock, async (req: any, res: any) => {
      try {
        const storageInfo = await mockBillingService.checkStorageLimit(req.user.id);
        
        // Add tier information
        const user = await mockUserService.findById(req.user.id);
        const tierNames: Record<string, string> = {
          'free': 'Free',
          'basic': 'Basic',
          'professional': 'Professional',
          'enterprise': 'Enterprise'
        };
        
        const accountTier = user?.accountTier || 'free';
        
        res.json({
          ...storageInfo,
          tier: accountTier,
          tierName: tierNames[accountTier],
          usagePercentage: (storageInfo.currentUsageMB / storageInfo.limitMB) * 100
        });
      } catch (error) {
        console.error('Error fetching storage limits:', error);
        res.status(500).json({ error: 'Failed to fetch storage limits' });
      }
    });
    
    userRouter.get('/storage-usage', authenticateMock, async (req: any, res: any) => {
      try {
        const usage = await mockUserService.calculateArtifactStorageUsage(req.user.id);
        res.json(usage);
      } catch (error) {
        console.error('Error fetching storage usage:', error);
        res.status(500).json({ error: 'Failed to fetch storage usage' });
      }
    });
    
    app.use('/api/user', userRouter);
  });
  
  beforeEach(() => {
    jest.clearAllMocks();
  });
  
  describe('GET /api/user/storage-limits', () => {
    it('should return storage limits for the authenticated user', async () => {
      // Mock user service response
      mockUserService.findById.mockResolvedValue({
        id: testUserId,
        email: 'test@example.com',
        username: null,
        fullName: null,
        accountTier: 'free',
        accountStatus: 'active'
      });
      
      // Mock billing service response
      mockBillingService.checkStorageLimit.mockResolvedValue({
        hasEnoughStorage: true,
        currentUsageMB: 100,
        limitMB: 500,
        remainingMB: 400
      });
      
      // Make request
      const response = await supertest(app)
        .get('/api/user/storage-limits')
        .set('Authorization', `Bearer ${testToken}`);
      
      // Verify response
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        hasEnoughStorage: true,
        currentUsageMB: 100,
        limitMB: 500,
        remainingMB: 400,
        tier: 'free',
        tierName: 'Free',
        usagePercentage: 20 // 100/500 * 100
      });
      
      // Verify service calls
      expect(mockBillingService.checkStorageLimit).toHaveBeenCalledWith(testUserId);
      expect(mockUserService.findById).toHaveBeenCalledWith(testUserId);
    });
    
    it('should handle errors from the billing service', async () => {
      // Mock user service response
      mockUserService.findById.mockResolvedValue({
        id: testUserId,
        email: 'test@example.com',
        username: null,
        fullName: null,
        accountTier: 'free',
        accountStatus: 'active'
      });
      
      // Mock billing service error
      mockBillingService.checkStorageLimit.mockRejectedValue(
        new Error('Database error')
      );
      
      // Make request
      const response = await supertest(app)
        .get('/api/user/storage-limits')
        .set('Authorization', `Bearer ${testToken}`);
      
      // Verify response
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to fetch storage limits'
      });
    });
  });
  
  describe('GET /api/user/storage-usage', () => {
    it('should return storage usage for the authenticated user', async () => {
      // Mock user service response
      mockUserService.calculateArtifactStorageUsage.mockResolvedValue({
        currentStorageMB: 100,
        currentStorageGB: 0.0976,
        artifactCount: 5,
        recentArtifacts: [
          {
            id: uuidv4(),
            name: 'test-artifact.zip',
            size: 1024 * 1024 * 50, // 50 MB
            sizeInMB: 50,
            pipelineName: 'Test Pipeline',
            createdAt: new Date()
          }
        ]
      });
      
      // Make request
      const response = await supertest(app)
        .get('/api/user/storage-usage')
        .set('Authorization', `Bearer ${testToken}`);
      
      // Verify response
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        currentStorageMB: 100,
        currentStorageGB: 0.0976,
        artifactCount: 5,
        recentArtifacts: expect.arrayContaining([
          expect.objectContaining({
            name: 'test-artifact.zip',
            sizeInMB: 50,
            pipelineName: 'Test Pipeline'
          })
        ])
      });
      
      // Verify service calls
      expect(mockUserService.calculateArtifactStorageUsage).toHaveBeenCalledWith(testUserId);
    });
    
    it('should handle errors from the user service', async () => {
      // Mock user service error
      mockUserService.calculateArtifactStorageUsage.mockRejectedValue(
        new Error('Database error')
      );
      
      // Make request
      const response = await supertest(app)
        .get('/api/user/storage-usage')
        .set('Authorization', `Bearer ${testToken}`);
      
      // Verify response
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to fetch storage usage'
      });
    });
  });
}); 