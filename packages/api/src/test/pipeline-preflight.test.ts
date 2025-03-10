import { PrismaClient } from '@prisma/client';
import { PipelinePreflightService } from '../services/pipeline-preflight.service';
import { BillingService } from '../services/billing.service';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Define types for our test data
interface Pipeline {
  id: string;
  createdById: string | null;
  createdBy?: {
    id: string;
    accountTier: string;
  };
  [key: string]: any;
}

interface StorageCheckResult {
  hasEnoughStorage: boolean;
  currentUsageMB: number;
  limitMB: number;
  remainingMB: number;
}

// Create manual mocks instead of using jest.mock()
const mockPipelineFindUnique = jest.fn<() => Promise<Pipeline | null>>();
const mockCheckStorageLimit = jest.fn<() => Promise<StorageCheckResult>>();

// Mock PrismaClient constructor
const mockPrismaClient = {
  pipeline: {
    findUnique: mockPipelineFindUnique
  }
};

// Mock BillingService constructor
const mockBillingService = {
  checkStorageLimit: mockCheckStorageLimit
};

// Mock the constructors
jest.mock('@prisma/client', () => ({
  PrismaClient: function() {
    return mockPrismaClient;
  }
}));

jest.mock('../services/billing.service', () => ({
  BillingService: function() {
    return mockBillingService;
  }
}));

describe('PipelinePreflightService', () => {
  let pipelinePreflightService: PipelinePreflightService;
  
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    
    // Create instance of service with mocked dependencies
    pipelinePreflightService = new PipelinePreflightService(
      mockPrismaClient as any,
      mockBillingService as any
    );
  });
  
  describe('performChecks', () => {
    it('should return error when pipeline not found', async () => {
      // Arrange
      mockPipelineFindUnique.mockReturnValue(Promise.resolve(null));
      
      // Act
      const result = await pipelinePreflightService.performChecks('non-existent-id');
      
      // Assert
      expect(result.canRun).toBe(false);
      expect(result.errors).toContain('Pipeline not found');
      expect(result.pipeline).toBeNull();
      expect(mockPipelineFindUnique).toHaveBeenCalledWith({
        where: { id: 'non-existent-id' },
        include: { createdBy: true }
      });
    });
    
    it('should return error when pipeline has no associated user', async () => {
      // Arrange
      const pipelineWithNoUser: Pipeline = {
        id: 'pipeline-1',
        createdById: null
      };
      mockPipelineFindUnique.mockReturnValue(Promise.resolve(pipelineWithNoUser));
      
      // Act
      const result = await pipelinePreflightService.performChecks('pipeline-1');
      
      // Assert
      expect(result.canRun).toBe(false);
      expect(result.errors).toContain('Pipeline has no associated user');
      expect(result.pipeline).toBe(pipelineWithNoUser);
    });
    
    it('should return error when user exceeds storage limit', async () => {
      // Arrange
      const userId = 'user-1';
      const pipeline: Pipeline = {
        id: 'pipeline-1',
        createdById: userId,
        createdBy: {
          id: userId,
          accountTier: 'free'
        }
      };
      mockPipelineFindUnique.mockReturnValue(Promise.resolve(pipeline));
      
      // Mock the storage check to return exceeded limit
      const storageCheckResult: StorageCheckResult = {
        hasEnoughStorage: false,
        currentUsageMB: 1050,
        limitMB: 1000,
        remainingMB: -50
      };
      mockCheckStorageLimit.mockReturnValue(Promise.resolve(storageCheckResult));
      
      // Act
      const result = await pipelinePreflightService.performChecks('pipeline-1');
      
      // Assert
      expect(result.canRun).toBe(false);
      expect(result.errors[0]).toContain('Storage limit exceeded');
      expect(result.errors[0]).toContain('1050.00 MB out of 1000 MB');
      expect(mockCheckStorageLimit).toHaveBeenCalledWith(userId);
    });
    
    it('should add warning when storage space is running low', async () => {
      // Arrange
      const userId = 'user-1';
      const pipeline: Pipeline = {
        id: 'pipeline-1',
        createdById: userId,
        createdBy: {
          id: userId,
          accountTier: 'pro'
        }
      };
      mockPipelineFindUnique.mockResolvedValue(pipeline);
      
      // Mock the storage check to return low remaining space
      const storageCheckResult: StorageCheckResult = {
        hasEnoughStorage: true,
        currentUsageMB: 950,
        limitMB: 1000,
        remainingMB: 50
      };
      mockCheckStorageLimit.mockResolvedValue(storageCheckResult);
      
      // Act
      const result = await pipelinePreflightService.performChecks('pipeline-1');
      
      // Assert
      expect(result.canRun).toBe(true);
      expect(result.warnings[0]).toContain('Storage space is running low');
      expect(result.warnings[0]).toContain('50.00 MB remaining');
    });
    
    it('should add warning when storage check fails', async () => {
      // Arrange
      const userId = 'user-1';
      const pipeline: Pipeline = {
        id: 'pipeline-1',
        createdById: userId,
        createdBy: {
          id: userId,
          accountTier: 'enterprise'
        }
      };
      mockPipelineFindUnique.mockResolvedValue(pipeline);
      
      // Mock the storage check to throw an error
      mockCheckStorageLimit.mockRejectedValue(new Error('Database connection error'));
      
      // Mock console.error to prevent test output pollution
      jest.spyOn(console, 'error').mockImplementation(() => {});
      
      // Act
      const result = await pipelinePreflightService.performChecks('pipeline-1');
      
      // Assert
      expect(result.canRun).toBe(true);
      expect(result.warnings).toContain('Could not verify storage limits. Proceeding with caution.');
      expect(console.error).toHaveBeenCalled();
    });
    
    it('should return successful result when all checks pass', async () => {
      // Arrange
      const userId = 'user-1';
      const pipeline: Pipeline = {
        id: 'pipeline-1',
        createdById: userId,
        createdBy: {
          id: userId,
          accountTier: 'business'
        }
      };
      mockPipelineFindUnique.mockResolvedValue(pipeline);
      
      // Mock the storage check to return plenty of space
      const storageCheckResult: StorageCheckResult = {
        hasEnoughStorage: true,
        currentUsageMB: 500,
        limitMB: 1000,
        remainingMB: 500
      };
      mockCheckStorageLimit.mockResolvedValue(storageCheckResult);
      
      // Act
      const result = await pipelinePreflightService.performChecks('pipeline-1');
      
      // Assert
      expect(result.canRun).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(result.pipeline).toBe(pipeline);
    });
  });
});