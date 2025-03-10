import { PrismaClient } from '@prisma/client';
import { BillingService } from '../services/billing.service';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Create a mock PrismaClient with any type
const mockPrismaClient: any = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn()
  },
  usageRecord: {
    create: jest.fn(),
    findMany: jest.fn()
  },
  $executeRaw: jest.fn(),
  $queryRaw: jest.fn(),
  $transaction: jest.fn((callback: any) => callback(mockPrismaClient))
};

describe('BillingService', () => {
  let billingService: BillingService;
  
  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();
    
    // Create a new BillingService with the mock PrismaClient
    billingService = new BillingService(mockPrismaClient as unknown as PrismaClient);
  });
  
  describe('getUserBillingUsage', () => {
    it('should retrieve user billing usage for the current month', async () => {
      // Arrange
      const userId = 'test-user-id';
      const currentMonth = new Date().toISOString().substring(0, 7);
      
      // Mock storage records using $queryRaw
      mockPrismaClient.$queryRaw.mockResolvedValueOnce([
        { quantity: 5120 } // 5GB in MB
      ]);

      // Mock the user.findUnique response
      mockPrismaClient.user.findUnique.mockResolvedValueOnce({
        id: userId,
        email: 'test@example.com',
        username: 'testuser',
        passwordHash: 'hash',
        fullName: 'Test User',
        createdAt: new Date(),
        updatedAt: new Date(),
        accountStatus: 'active',
        accountTier: 'free',
        usage_history: {
          [currentMonth]: {
            build_minutes: 120,
            storage_gb: 5
          }
        }
      });
      
      // Act
      const usage = await billingService.getUserBillingUsage(userId);
      
      // Assert
      expect(usage).toEqual({
        currentMonth: {
          build_minutes: 120,
          storage_gb: 5
        }
      });
      
      // Verify the user query was called
      expect(mockPrismaClient.user.findUnique).toHaveBeenCalledWith({
        where: { id: userId }
      });
      expect(mockPrismaClient.$queryRaw).toHaveBeenCalled();
    });
    
    it('should handle users with no billing history', async () => {
      // Arrange
      const userId = 'new-user-id';
      
      // Mock empty storage records
      mockPrismaClient.$queryRaw.mockResolvedValueOnce([]);
      
      // Mock user with no usage history
      mockPrismaClient.user.findUnique.mockResolvedValueOnce({
        id: userId,
        email: 'new@example.com',
        username: 'newuser',
        passwordHash: 'hash',
        fullName: 'New User',
        createdAt: new Date(),
        updatedAt: new Date(),
        accountStatus: 'active',
        accountTier: 'free',
        usage_history: {} // Empty usage history
      });
      
      // Act
      const usage = await billingService.getUserBillingUsage(userId);
      
      // Assert
      expect(usage).toEqual({
        currentMonth: {
          build_minutes: 0,
          storage_gb: 0
        }
      });
    });
  });
}); 