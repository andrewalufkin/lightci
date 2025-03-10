import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PipelineRunnerService } from '../services/pipeline-runner.service';
import { WorkspaceService } from '../services/workspace.service';
import { BillingService } from '../services/billing.service';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

// Mock dependencies
jest.mock('../services/workspace.service');
jest.mock('../services/billing.service');

// Define types for our test data
type MockPipeline = {
  id: string;
  createdById: string | null;
  createdBy?: { accountTier: string };
  steps?: string;
};

type MockPipelineRun = {
  id: string;
};

// Define storage limit response type
type StorageLimitResponse = {
  hasEnoughStorage: boolean;
  currentUsageMB: number;
  limitMB: number;
  remainingMB: number;
};

describe('Pipeline Runner Storage Limits', () => {
  let pipelineRunnerService: PipelineRunnerService;
  let mockWorkspaceService: jest.Mocked<WorkspaceService>;
  let mockPrismaClient: any;
  
  const testPipelineId = uuidv4();
  const testUserId = uuidv4();
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Create mock Prisma client
    mockPrismaClient = {
      pipeline: {
        findUnique: jest.fn(),
        update: jest.fn()
      },
      pipelineRun: {
        create: jest.fn()
      }
    };
    
    // Set default return values
    mockPrismaClient.pipeline.findUnique.mockResolvedValue({
      id: testPipelineId,
      createdById: testUserId,
      createdBy: {
        accountTier: 'free'
      },
      steps: JSON.stringify([{ name: 'Test Step', command: 'echo "test"' }])
    });
    
    mockPrismaClient.pipelineRun.create.mockResolvedValue({ 
      id: uuidv4() 
    });
    
    // Set up mock workspace service
    mockWorkspaceService = {} as any;
    
    // Create pipeline runner service with mocked dependencies
    pipelineRunnerService = new PipelineRunnerService(
      mockWorkspaceService,
      mockPrismaClient
    );
    
    // Replace the billing service with our mock
    (pipelineRunnerService as any).billingService = {
      checkStorageLimit: jest.fn()
    };
  });
  
  it('should run pipeline when user has enough storage', async () => {
    // Mock storage check result - user has enough storage
    const storageLimitResponse: StorageLimitResponse = {
      hasEnoughStorage: true,
      currentUsageMB: 100,
      limitMB: 500,
      remainingMB: 400
    };
    
    (pipelineRunnerService as any).billingService.checkStorageLimit.mockResolvedValue(storageLimitResponse);
    
    // Call the method
    const result = await pipelineRunnerService.runPipeline(testPipelineId, 'main', testUserId);
    
    // Verify the result is a string (run ID)
    expect(typeof result).toBe('string');
    
    // Verify storage check was called
    expect((pipelineRunnerService as any).billingService.checkStorageLimit).toHaveBeenCalledWith(testUserId);
    
    // Verify pipeline run was created
    expect(mockPrismaClient.pipelineRun.create).toHaveBeenCalled();
  });
  
  it('should throw error when user has exceeded storage limit', async () => {
    // Mock storage check result - user has exceeded storage limit
    const storageLimitResponse: StorageLimitResponse = {
      hasEnoughStorage: false,
      currentUsageMB: 600,
      limitMB: 500,
      remainingMB: 0
    };
    
    (pipelineRunnerService as any).billingService.checkStorageLimit.mockResolvedValue(storageLimitResponse);
    
    // Expect the method to throw an error
    await expect(pipelineRunnerService.runPipeline(testPipelineId, 'main', testUserId))
      .rejects
      .toThrow(/Storage limit exceeded/);
    
    // Verify storage check was called
    expect((pipelineRunnerService as any).billingService.checkStorageLimit).toHaveBeenCalledWith(testUserId);
    
    // Verify pipeline run was NOT created
    expect(mockPrismaClient.pipelineRun.create).not.toHaveBeenCalled();
  });
  
  it('should handle pipeline with no associated user', async () => {
    // Mock pipeline with no user for this test only
    mockPrismaClient.pipeline.findUnique.mockResolvedValueOnce({
      id: testPipelineId,
      createdById: null
    });
    
    // Expect the method to throw an error
    await expect(pipelineRunnerService.runPipeline(testPipelineId, 'main', testUserId))
      .rejects
      .toThrow('Pipeline has no associated user');
    
    // Verify storage check was NOT called
    expect((pipelineRunnerService as any).billingService.checkStorageLimit).not.toHaveBeenCalled();
    
    // Verify pipeline run was NOT created
    expect(mockPrismaClient.pipelineRun.create).not.toHaveBeenCalled();
  });
});