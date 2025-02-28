import { DeploymentService, DeploymentResult } from '../deployment.service';
import { prisma } from '../../db';
import { EngineService } from '../engine.service';
import * as AWS from 'aws-sdk';

// Mock the dependencies
jest.mock('../../db', () => ({
  prisma: {
    pipelineRun: {
      findUnique: jest.fn(),
      update: jest.fn()
    }
  }
}));

jest.mock('../engine.service');
jest.mock('aws-sdk');
jest.mock('child_process', () => ({
  exec: jest.fn(),
  spawn: jest.fn().mockImplementation(() => ({
    on: jest.fn((event, callback) => {
      if (event === 'close') {
        callback(0); // Simulate successful completion
      }
    })
  }))
}));
jest.mock('fs', () => ({
  mkdtempSync: jest.fn().mockReturnValue('/tmp/mock-dir'),
  writeFileSync: jest.fn(),
  rmSync: jest.fn(),
  promises: {
    rm: jest.fn()
  },
  existsSync: jest.fn().mockReturnValue(true)
}));
jest.mock('path', () => ({
  join: jest.fn().mockImplementation((...args) => args.join('/')),
  dirname: jest.fn().mockReturnValue('/tmp'),
  basename: jest.fn().mockReturnValue('artifacts')
}));
jest.mock('os', () => ({
  tmpdir: jest.fn().mockReturnValue('/tmp')
}));

describe('DeploymentService', () => {
  let deploymentService: DeploymentService;
  
  beforeEach(() => {
    deploymentService = new DeploymentService();
    jest.clearAllMocks();
  });
  
  describe('deployPipelineRun', () => {
    it('should return error if pipeline run not found', async () => {
      // Mock the prisma findUnique to return null
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue(null);
      
      const result = await deploymentService.deployPipelineRun('non-existent-id');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Pipeline run not found');
    });
    
    it('should return error if pipeline run status is not completed', async () => {
      // Mock the prisma findUnique to return a run with failed status
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue({
        id: 'run-1',
        pipelineId: 'pipeline-1',
        status: 'failed',
        pipeline: {
          deploymentEnabled: true
        }
      });
      
      const result = await deploymentService.deployPipelineRun('run-1');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Cannot deploy a failed or incomplete pipeline run');
    });
    
    it('should return error if deployment is not enabled', async () => {
      // Mock the prisma findUnique to return a run with deployment disabled
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue({
        id: 'run-1',
        pipelineId: 'pipeline-1',
        status: 'completed',
        pipeline: {
          deploymentEnabled: false
        }
      });
      
      const result = await deploymentService.deployPipelineRun('run-1');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Deployment is not enabled for this pipeline');
    });
    
    it('should return error if no deployment platform configured', async () => {
      // Mock the prisma findUnique to return a run with no platform
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue({
        id: 'run-1',
        pipelineId: 'pipeline-1',
        status: 'completed',
        pipeline: {
          deploymentEnabled: true,
          deploymentPlatform: null
        }
      });
      
      const result = await deploymentService.deployPipelineRun('run-1');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('No deployment platform configured');
    });
    
    it('should return not implemented for non-EC2 platforms', async () => {
      // Mock the prisma findUnique to return a run with GCP platform
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue({
        id: 'run-1',
        pipelineId: 'pipeline-1',
        status: 'completed',
        logs: [],
        pipeline: {
          deploymentEnabled: true,
          deploymentPlatform: 'gcp',
          deploymentConfig: {}
        }
      });
      
      // Mock the engine service getBuild
      (EngineService.prototype.getBuild as jest.Mock).mockResolvedValue({
        id: 'run-1'
      });
      
      const result = await deploymentService.deployPipelineRun('run-1');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Deployment to gcp is not yet implemented');
    });
    
    it('should validate required AWS EC2 configuration', async () => {
      // Mock the prisma findUnique to return a run with EC2 platform but missing config
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue({
        id: 'run-1',
        pipelineId: 'pipeline-1',
        status: 'completed',
        logs: [],
        pipeline: {
          deploymentEnabled: true,
          deploymentPlatform: 'aws_ec2',
          deploymentConfig: {
            // Missing required fields
          }
        }
      });
      
      // Mock the engine service getBuild
      (EngineService.prototype.getBuild as jest.Mock).mockResolvedValue({
        id: 'run-1'
      });
      
      const result = await deploymentService.deployPipelineRun('run-1');
      
      expect(result.success).toBe(false);
      expect(result.message).toBe('Missing required AWS EC2 configuration');
    });
    
    it('should update pipeline run with deployment logs', async () => {
      // Mock the prisma findUnique to return a run with GCP platform
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue({
        id: 'run-1',
        pipelineId: 'pipeline-1',
        status: 'completed',
        logs: ['previous log'],
        pipeline: {
          deploymentEnabled: true,
          deploymentPlatform: 'gcp',
          deploymentConfig: {}
        }
      });
      
      // Mock the engine service getBuild
      (EngineService.prototype.getBuild as jest.Mock).mockResolvedValue({
        id: 'run-1'
      });
      
      // Mock the prisma update
      (prisma.pipelineRun.update as jest.Mock).mockResolvedValue({});
      
      await deploymentService.deployPipelineRun('run-1');
      
      // Verify logs were updated
      expect(prisma.pipelineRun.update).toHaveBeenCalledWith({
        where: { id: 'run-1' },
        data: {
          logs: {
            push: [
              'previous log',
              '[DEPLOYMENT] Deployment to gcp is not yet implemented'
            ]
          }
        }
      });
    });
  });
});