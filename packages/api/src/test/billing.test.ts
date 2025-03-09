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
const mockFindUnique: any = jest.fn();
const mockCreate: any = jest.fn();
const mockUpdate: any = jest.fn();
const mockExecuteRaw: any = jest.fn();
const mockTransaction: any = jest.fn();

// Create a mock PrismaClient with proper typing
const mockPrismaClient = {
  pipelineRun: {
    findUnique: mockFindUnique,
    create: mockCreate
  },
  pipeline: {
    create: jest.fn()
  },
  user: {
    findUnique: mockFindUnique,
    update: mockUpdate
  },
  usage_records: {
    create: mockCreate
  },
  $executeRaw: mockExecuteRaw,
  $transaction: mockTransaction
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
    const startTime = new Date();
    startTime.setMinutes(startTime.getMinutes() - durationMinutes);
    
    const completedAt = isCompleted ? new Date() : null;
    
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
    mockFindUnique.mockImplementation((args: any) => {
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
    it('should track build minutes and create usage record for completed runs', async () => {
      // Act
      const result = await billingService.trackBuildMinutes(runId);
      
      // Assert: Check that the correct queries were performed
      expect(mockFindUnique).toHaveBeenCalledWith({ 
        where: { id: runId },
        include: { pipeline: { select: { createdById: true, projectId: true } } }
      });
      
      // Check that a usage record was created
      expect(mockCreate).toHaveBeenCalled();
      
      // Check that user was found and updated
      expect(mockFindUnique).toHaveBeenCalledWith({ 
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
      mockFindUnique.mockImplementationOnce((args: any) => {
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
      expect(mockFindUnique).toHaveBeenCalledWith({ 
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
      mockFindUnique.mockImplementationOnce((args: any) => {
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
      mockFindUnique.mockImplementationOnce((args: any) => {
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
      mockFindUnique.mockImplementationOnce(() => Promise.resolve(null));
      
      // Act & Assert: Expect the function to throw an error
      await expect(billingService.trackBuildMinutes('non-existent-id'))
        .rejects.toThrow('Error tracking build minutes: Pipeline run not found');
    });
    
    it('should handle database errors gracefully', async () => {
      // Arrange: Mock a database error
      mockFindUnique.mockImplementationOnce(() => {
        throw new Error('Database connection failed');
      });
      
      // Act & Assert: Expect the function to throw an error
      await expect(billingService.trackBuildMinutes(runId))
        .rejects.toThrow('Error tracking build minutes: Database connection failed');
    });
    
    it('should use a transaction to ensure atomicity', async () => {
      // Act
      await billingService.trackBuildMinutes(runId);
      
      // Assert: Verify that a transaction was used
      expect(mockTransaction).toHaveBeenCalled();
    });
  });
  
  describe('getUserBillingUsage', () => {
    it('should return the current month usage data', async () => {
      // Arrange
      const currentMonth = new Date().toISOString().substring(0, 7);
      
      // Act
      const result = await billingService.getUserBillingUsage(userId);
      
      // Assert
      expect(result).toEqual({
        currentMonth: {
          build_minutes: 30,
          storage_gb: 0
        }
      });
      
      // Verify the user was queried
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { id: userId } });
    });
    
    it('should handle users with no usage history', async () => {
      // Arrange: Mock a user with no usage history
      mockFindUnique.mockImplementationOnce((args: any) => {
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
            usage_history: {}
          });
        }
        return Promise.resolve(null);
      });
      
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
      mockFindUnique.mockImplementationOnce(() => {
        throw new Error('Database connection failed');
      });
      
      // Act & Assert
      await expect(billingService.getUserBillingUsage(userId))
        .rejects.toThrow('Error getting user billing usage: Database connection failed');
    });
  });
});