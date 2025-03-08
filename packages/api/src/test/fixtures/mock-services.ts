import { PipelineRunnerService } from '../../services/pipeline-runner.service.js';
import { WorkspaceService } from '../../services/workspace.service.js';
import { PrismaClient } from '@prisma/client';

/**
 * Mock PipelineRunnerService for tests that doesn't actually run pipelines asynchronously
 */
export class MockPipelineRunnerService extends PipelineRunnerService {
  protected prisma: PrismaClient;

  constructor(workspaceService: WorkspaceService, prisma: PrismaClient) {
    super(workspaceService, prisma);
    this.prisma = prisma;
  }

  async runPipeline(pipelineId: string, branch: string, commit?: string): Promise<string> {
    // Get pipeline data
    const pipelineData = await this.prisma.pipeline.findUnique({
      where: { id: pipelineId }
    });

    if (!pipelineData) {
      throw new Error('Pipeline not found');
    }

    // Create pipeline run
    const pipelineRun = await this.prisma.pipelineRun.create({
      data: {
        pipeline: {
          connect: { id: pipelineId }
        },
        branch,
        commit,
        status: 'running',
        stepResults: JSON.stringify([]),
        logs: []
      }
    });

    // Update pipeline status to running
    await this.prisma.pipeline.update({
      where: { id: pipelineId },
      data: { status: 'running' }
    });

    // In the mock, we don't actually run the pipeline
    // This prevents hanging tests due to background processes

    return pipelineRun.id;
  }
} 