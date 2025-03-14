import { PipelineRunnerService } from '../../services/pipeline-runner.service.js';
import { WorkspaceService } from '../../services/workspace.service.js';
import { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../../utils/errors.js';
import { EngineService } from '../../services/engine.service.js';

/**
 * Mock PipelineRunnerService for tests that doesn't actually run pipelines asynchronously
 */
export class MockPipelineRunnerService extends PipelineRunnerService {
  protected prisma: PrismaClient;

  constructor(
    prismaClient: PrismaClient = prisma,
    engineService: EngineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3001'),
    workspaceService: WorkspaceService = new WorkspaceService()
  ) {
    super(prismaClient, engineService, workspaceService);
    this.prisma = prismaClient;
  }

  async runPipeline(pipelineId: string, branch: string, userId: string, commit?: string, existingRunId?: string): Promise<string> {
    // Get pipeline data with ownership check
    const pipelineData = await this.prisma.pipeline.findFirst({
      where: { 
        id: pipelineId,
        createdById: userId
      }
    });

    if (!pipelineData) {
      throw new NotFoundError('Pipeline not found or access denied');
    }

    if (existingRunId) {
      // Update existing run
      await this.prisma.pipelineRun.update({
        where: { id: existingRunId },
        data: {
          status: 'running',
          stepResults: JSON.stringify([]),
          startedAt: new Date()
        }
      });
      return existingRunId;
    }

    // Create pipeline run
    const pipelineRun = await this.prisma.pipelineRun.create({
      data: {
        pipeline: {
          connect: { id: pipelineId }
        },
        branch,
        commit,
        status: 'pending',
        stepResults: JSON.stringify([]),
        logs: [],
        startedAt: new Date()
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