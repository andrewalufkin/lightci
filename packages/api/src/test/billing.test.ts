import { PrismaClient } from '@prisma/client';
import { BillingService } from '../services/billing.service';
import { createTestUser } from './fixtures/users';
import { mockPipelineRun } from './mocks/pipelineRunMock';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Type for the mock pipeline run result
type MockPipelineRunResult = {
  id: string;
  pipelineId: string;
  status: string;
  branch: string;
  commit: string;
  startedAt: Date;
  completedAt: Date | null;
  stepResults: any[];
  logs: any[];
  pipeline: {
    createdById: string;
    projectId: string;
  };
};

// Create proper Jest mocks for Prisma methods
const mockUserFindUnique: any = jest.fn();
const mockPipelineRunFindUnique: any = jest.fn();
const mockCreate: any = jest.fn();
const mockUpdate: any = jest.fn();
const mockExecuteRaw: any = jest.fn();
const mockTransaction: any = jest.fn();
const mockFindMany: any = jest.fn();
const mockQueryRaw: any = jest.fn();

// Create a mock PrismaClient with proper typing
const mockPrismaClient = {
  pipelineRun: {
    findUnique: mockPipelineRunFindUnique,
    create: mockCreate
  },
  pipeline: {
    create: jest.fn()
  },
  user: {
    findUnique: mockUserFindUnique,
    update: mockUpdate,
    findMany: mockFindMany
  },
  usageRecord: {
    create: mockCreate,
    findMany: mockFindMany
  },
  $executeRaw: mockExecuteRaw,
  $queryRaw: mockQueryRaw,
  $transaction: (callback: any) => callback(mockPrismaClient)
} as unknown as PrismaClient;

// Mock the transaction to execute the callback with the mock client
mockTransaction.mockImplementation((callback: any) => callback(mockPrismaClient));

describe('BillingService', () => {
  let billingService: BillingService;
  let userId: string;
  let pipelineId: string;
  let runId: string;
  
  // Helper to create a pipeline run with specific duration
  const createPipelineRunWithDuration = async (durationMinutes: number, isCompleted = true) => {
    const now = new Date();
    const startTime = new Date(now.getTime() - durationMinutes * 60 * 1000);
    
    const completedAt = isCompleted ? now : null;
    
    return mockPipelineRun(pipelineId, {
      status: isCompleted ? 'completed' : 'running',
      startedAt: startTime,
      completedAt
    });
  };  
  
  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Set up test IDs
    userId = 'test-user-id';
    pipelineId = 'test-pipeline-id';
    
    // Initialize billing service with dependency injection
    billingService = new BillingService(mockPrismaClient);
    
    // Mock database responses for standard case
    const standardRunDuration = 30;
    const standardRun = await createPipelineRunWithDuration(standardRunDuration);
    runId = standardRun.id;
    
    // Mock the pipeline run lookup
    mockPipelineRunFindUnique.mockImplementation((args: any) => {
      if (args.where && args.where.id === runId) {
        return Promise.resolve({
          ...standardRun,
          pipeline: { createdById: userId, projectId: 'test-project-id' }
        });
      } else if (args.where && args.where.id === userId) {
        // Mock user lookup
        const currentMonth = new Date().toISOString().substring(0, 7);
        return Promise.resolve({
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
              build_minutes: standardRunDuration
            }
          }
        });
      }
      return Promise.resolve(null);
    });
    
    // Mock the usage_records.create method
    mockCreate.mockImplementation((args: any) => {
      if (args.data && args.data.usage_type === 'build_minutes') {
        return Promise.resolve({
          id: args.data.id,
          user_id: args.data.user_id,
          usage_type: args.data.usage_type,
          quantity: args.data.quantity,
          timestamp: args.data.timestamp,
          metadata: args.data.metadata,
          pipeline_run_id: args.data.pipeline_run_id,
          project_id: args.data.project_id
        });
      }
      return Promise.resolve({});
    });
    
    // Mock the user.update method
    mockUpdate.mockImplementation((args: any) => {
      if (args.where && args.where.id === userId) {
        return Promise.resolve({
          id: userId,
          email: 'test@example.com',
          username: 'testuser',
          passwordHash: 'hash',
          fullName: 'Test User',
          createdAt: new Date(),
          updatedAt: new Date(),
          accountStatus: 'active',
          accountTier: 'free',
          usage_history: args.data.usage_history
        });
      }
      return Promise.resolve({});
    });
  });
  
  describe('trackBuildMinutes', () => {
    let runId: string;
    
    beforeEach(() => {
      // Reset mocks
      jest.clearAllMocks();
      
      // Set up default test data
      runId = 'test-run-id';
      
      // Mock the pipeline run lookup
      mockPipelineRunFindUnique.mockImplementation((args: any) => {
        if (args.where && args.where.id === runId) {
          return Promise.resolve({
            id: runId,
            startedAt: new Date('2023-01-01T10:00:00Z'),
            completedAt: new Date('2023-01-01T11:00:00Z'), // 1 hour = 60 minutes
            pipeline: {
              createdById: userId,
              projectId: 'test-project-id'
            }
          });
        }
        return Promise.resolve(null);
      });
      
      // Mock the user lookup for updateUserUsageHistory
      mockUserFindUnique.mockImplementation((args: any) => {
        if (args.where && args.where.id === userId) {
          return Promise.resolve({
            id: userId,
            usage_history: {}
          });
        }
        return Promise.resolve(null);
      });
    });
    
    it('should track build minutes and create usage record for completed runs', async () => {
      // Act
      const result = await billingService.trackBuildMinutes(runId);
      
      // Assert: Check that the correct queries were performed
      expect(mockPipelineRunFindUnique).toHaveBeenCalledWith({ 
        where: { id: runId },
        include: { pipeline: { select: { createdById: true, projectId: true } } }
      });
      
      // Check that a usage record was created
      expect(mockCreate).toHaveBeenCalled();
      
      // Check that user was found and updated
      expect(mockUserFindUnique).toHaveBeenCalledWith({ 
        where: { id: userId }
      });
      
      expect(mockUpdate).toHaveBeenCalled();
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('quantity');
    });
    
    it('should handle pipeline runs without completedAt (still running)', async () => {
      // Arrange: Create a pipeline run that's still running (15 minutes so far)
      const runningDuration = 15;
      const runningRun = await createPipelineRunWithDuration(runningDuration, false);
      
      // Mock the pipeline run lookup for this test
      mockPipelineRunFindUnique.mockImplementationOnce((args: any) => {
        if (args.where && args.where.id === runningRun.id) {
          return Promise.resolve({
            ...runningRun,
            pipeline: { createdById: userId, projectId: 'test-project-id' }
          });
        }
        return Promise.resolve(null);
      });
      
      // Act
      const result = await billingService.trackBuildMinutes(runningRun.id);
      
      // Assert: Verify that the correct queries were executed
      expect(mockPipelineRunFindUnique).toHaveBeenCalledWith({ 
        where: { id: runningRun.id },
        include: { pipeline: { select: { createdById: true, projectId: true } } }
      });
      
      // Check that a usage record was created
      expect(mockCreate).toHaveBeenCalled();
    });
    
    it('should handle very short runs (less than 1 minute)', async () => {
      // Arrange: Create a pipeline run that lasted only 30 seconds
      const shortDuration = 0.5; // 30 seconds in minutes
      const shortRun = await createPipelineRunWithDuration(shortDuration);
      
      // Mock the pipeline run lookup for this test
      mockPipelineRunFindUnique.mockImplementationOnce((args: any) => {
        if (args.where && args.where.id === shortRun.id) {
          return Promise.resolve({
            ...shortRun,
            pipeline: { createdById: userId, projectId: 'test-project-id' }
          });
        }
        return Promise.resolve(null);
      });
      
      // Act
      const result = await billingService.trackBuildMinutes(shortRun.id);
      
      // Assert: Verify that at least the minimum billable amount is charged
      expect(mockCreate).toHaveBeenCalled();
      expect(result.quantity).toBe(1); // Should round up to at least 1 minute
    });
    
    it('should handle very long runs (several hours)', async () => {
      // Arrange: Create a pipeline run that lasted 3 hours
      const longDuration = 180; // 3 hours in minutes
      const longRun = await createPipelineRunWithDuration(longDuration);
      
      // Mock the pipeline run lookup for this test
      mockPipelineRunFindUnique.mockImplementationOnce((args: any) => {
        if (args.where && args.where.id === longRun.id) {
          return Promise.resolve({
            ...longRun,
            pipeline: { createdById: userId, projectId: 'test-project-id' }
          });
        }
        return Promise.resolve(null);
      });
      
      // Act
      const result = await billingService.trackBuildMinutes(longRun.id);
      
      // Assert: Verify that the correct amount is recorded
      expect(mockCreate).toHaveBeenCalled();
      expect(result.quantity).toBe(180);
    });
    
    it('should handle errors when pipeline run not found', async () => {
      // Arrange: Mock a not found response
      mockPipelineRunFindUnique.mockImplementationOnce(() => Promise.resolve(null));
      
      // Act & Assert: Expect the function to throw an error
      await expect(billingService.trackBuildMinutes('non-existent-id'))
        .rejects.toThrow('Error tracking build minutes: Pipeline run not found');
    });
    
    it('should handle database errors gracefully', async () => {
      // Arrange: Mock a database error
      mockPipelineRunFindUnique.mockImplementationOnce(() => {
        throw new Error('Database connection failed');
      });
      
      // Act & Assert: Expect the function to throw an error
      await expect(billingService.trackBuildMinutes(runId))
        .rejects.toThrow('Error tracking build minutes: Database connection failed');
    });
    
    it('should use a transaction to ensure atomicity', async () => {
      // Arrange
      const transactionSpy = jest.spyOn(mockPrismaClient, '$transaction');
      
      // Act
      await billingService.trackBuildMinutes(runId);
      
      // Assert: Verify that a transaction was used
      expect(transactionSpy).toHaveBeenCalled();
      
      // Clean up
      transactionSpy.mockRestore();
    });
  });
  
  describe('getUserBillingUsage', () => {
    it('should return the current month usage data', async () => {
      // Arrange
      const currentMonth = new Date().toISOString().substring(0, 7);
      
      // Mock the user query
      mockUserFindUnique.mockImplementationOnce((args: any) => {
        if (args.where && args.where.id === userId) {
          return Promise.resolve({
            id: userId,
            usage_history: {
              [currentMonth]: {
                build_minutes: 30
              }
            }
          });
        }
        return null;
      });

      // Mock the storage records query using $queryRaw
      mockQueryRaw.mockResolvedValueOnce([
        { quantity: 1024 } // 1024 MB = 1 GB
      ]);

      // Act
      const result = await billingService.getUserBillingUsage(userId);

      // Assert
      expect(result).toEqual({
        currentMonth: {
          build_minutes: 30,
          storage_gb: 1 // 1024 MB = 1 GB
        }
      });

      // Verify the queries
      expect(mockUserFindUnique).toHaveBeenCalledWith({ where: { id: userId } });
      expect(mockQueryRaw).toHaveBeenCalled();
    });

    it('should handle users with no usage history', async () => {
      // Arrange: Mock a user with no usage history
      mockUserFindUnique.mockImplementationOnce((args: any) => {
        if (args.where && args.where.id === userId) {
          return Promise.resolve({
            id: userId,
            usage_history: {}
          });
        }
        return null;
      });

      // Mock empty storage records with $queryRaw
      mockQueryRaw.mockResolvedValueOnce([]);

      // Act
      const result = await billingService.getUserBillingUsage(userId);

      // Assert
      expect(result).toEqual({
        currentMonth: {
          build_minutes: 0,
          storage_gb: 0
        }
      });
    });

    it('should handle database errors gracefully', async () => {
      // Arrange: Mock a database error
      mockUserFindUnique.mockImplementationOnce(() => {
        throw new Error('Database connection failed');
      });

      // Act & Assert
      await expect(billingService.getUserBillingUsage(userId))
        .rejects.toThrow('Error getting user billing usage: Database connection failed');
    });
  });
});