// mocks/pipelineRunMock.ts

import { v4 as uuidv4 } from 'uuid';

/**
 * Creates a mock pipeline run object for testing
 * 
 * @param pipelineId The ID of the pipeline this run belongs to
 * @param overrides Any properties to override in the default mock
 * @returns A mock pipeline run object
 */
export const mockPipelineRun = (pipelineId: string, overrides = {}) => {
  const id = uuidv4();
  const now = new Date();
  
  const defaultRun = {
    id,
    pipelineId,
    status: 'completed',
    branch: 'main',
    commit: `${id.substring(0, 6)}`,
    startedAt: new Date(now.getTime() - 30 * 60000), // 30 minutes ago
    completedAt: now,
    stepResults: [],
    logs: [],
    pipeline: {
      createdById: 'test-user-id'
    }
  };
  
  return {
    ...defaultRun,
    ...overrides
  };
};