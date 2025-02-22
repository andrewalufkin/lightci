import { PrismaClient } from '@prisma/client';
import { WorkspaceService } from './workspace.service';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

const execAsync = promisify(exec);
const prisma = new PrismaClient();

interface StepResult {
  id: string;
  name: string;
  command: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime?: Date;
  endTime?: Date;
  output?: string;
  error?: string;
  environment?: Record<string, string>;
}

interface PipelineStep {
  id: string;
  name: string;
  command: string;
  timeout?: number;
  environment?: Record<string, string>;
}

interface WorkspaceConfig {
  name: string;
  repository: string;
}

interface Workspace {
  path: string;
}

type PipelineWithSteps = {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
  steps: PipelineStep[];
  status: string;
}

export class PipelineRunnerService {
  constructor(private workspaceService: WorkspaceService) {}

  private async executeCommand(command: string, workingDir: string, env: Record<string, string> = {}): Promise<{ output: string; error?: string }> {
    try {
      console.log(`[PipelineRunner] Executing command in directory:`, {
        command,
        workingDir,
        exists: await fs.access(workingDir).then(() => true).catch(() => false)
      });

      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDir,
        env: { ...process.env, ...env },
        timeout: 30 * 60 * 1000, // 30 minute timeout
      });
      return { output: stdout + stderr };
    } catch (error: any) {
      console.error('[PipelineRunner] Command execution failed:', {
        command,
        workingDir,
        error: error.message,
        stdout: error.stdout,
        stderr: error.stderr
      });
      return { 
        output: error.stdout + error.stderr,
        error: error.message 
      };
    }
  }

  async runPipeline(pipelineId: string, branch: string, commit?: string): Promise<string> {
    // Get pipeline details
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: pipelineId }
    }) as PipelineWithSteps | null;

    if (!pipeline) {
      throw new Error('Pipeline not found');
    }

    // Initialize step results from pipeline steps
    const steps = (typeof pipeline.steps === 'string' ? JSON.parse(pipeline.steps) : pipeline.steps) as PipelineStep[];
    console.log(`[PipelineRunner] Initializing step results from steps:`, {
      pipelineId,
      steps: steps.map(s => ({ id: s.id, name: s.name }))
    });

    const stepResults = steps.map(step => {
      // Use the step name as the ID if no ID is provided
      const stepId = step.id || step.name;
      console.log(`[PipelineRunner] Creating step result:`, {
        stepId,
        stepName: step.name
      });
      return {
        id: stepId,
        name: step.name,
        command: step.command,
        status: 'pending' as StepResult['status'],
        environment: step.environment || {},
        startTime: undefined as Date | undefined,
        endTime: undefined as Date | undefined,
        output: undefined as string | undefined,
        error: undefined as string | undefined
      };
    }) as StepResult[];

    console.log(`[PipelineRunner] Created step results:`, {
      pipelineId,
      stepResults: stepResults.map(sr => ({ id: sr.id, name: sr.name }))
    });

    // Create pipeline run
    const pipelineRun = await prisma.pipelineRun.create({
      data: {
        pipeline: {
          connect: { id: pipelineId }
        },
        branch,
        commit,
        status: 'running',
        stepResults: stepResults as any,
        logs: []
      }
    });

    // Update pipeline status to running
    await prisma.pipeline.update({
      where: { id: pipelineId },
      data: { status: 'running' }
    });

    // Run the pipeline asynchronously
    this.executePipeline(pipeline, pipelineRun.id, branch).catch(error => {
      console.error('Pipeline execution error:', error);
    });

    return pipelineRun.id;
  }

  private async executePipeline(pipeline: PipelineWithSteps, runId: string, branch: string): Promise<void> {
    let workspacePath: string | undefined;
    
    try {
      // Create workspace
      const workspace = await this.workspaceService.createWorkspace({
        name: pipeline.name,
        repository: pipeline.repository
      } as WorkspaceConfig);
      workspacePath = (workspace as unknown as Workspace).path;
      
      console.log(`[PipelineRunner] Created workspace:`, {
        workspacePath,
        exists: await fs.access(workspacePath).then(() => true).catch(() => false)
      });

      // Get the current step results from the pipeline run
      const pipelineRun = await prisma.pipelineRun.findUnique({
        where: { id: runId }
      });
      
      if (!pipelineRun) {
        throw new Error('Pipeline run not found');
      }

      console.log(`[PipelineRunner] Starting pipeline execution:`, {
        runId,
        pipelineId: pipeline.id,
        currentStatus: pipelineRun.status,
        currentStepResults: pipelineRun.stepResults
      });

      const steps = (typeof pipeline.steps === 'string' ? JSON.parse(pipeline.steps) : pipeline.steps) as PipelineStep[];
      const stepResults = pipelineRun.stepResults as StepResult[];

      console.log(`[PipelineRunner] Parsed step results:`, {
        runId,
        stepResults: JSON.stringify(stepResults)
      });

      // Execute each step
      for (const step of steps) {
        console.log(`[PipelineRunner] Looking for step result:`, {
          runId,
          step: {
            id: step.id,
            name: step.name
          },
          availableStepResults: stepResults.map(sr => ({
            id: sr.id,
            name: sr.name
          }))
        });

        // Find the corresponding step result
        const stepResult = stepResults.find(sr => 
          // Try to match by ID first
          (step.id && sr.id === step.id) ||
          // If no ID match, try to match by name
          (!step.id && sr.id === step.name)
        );

        if (!stepResult) {
          console.log(`[PipelineRunner] Warning: No step result found for step:`, {
            runId,
            stepId: step.id,
            stepName: step.name,
            stepResults: JSON.stringify(stepResults)
          });
          continue;
        }

        console.log(`[PipelineRunner] Starting step execution:`, {
          runId,
          stepId: stepResult.id,
          stepName: stepResult.name,
          currentStatus: stepResult.status
        });

        // Update step status to running
        stepResult.status = 'running';
        stepResult.startTime = new Date();

        // Add logging for step status update
        console.log(`[PipelineRunner] Updating step ${stepResult.name} status to running:`, {
          runId,
          stepId: stepResult.id,
          status: stepResult.status,
          stepResults: JSON.stringify(stepResults)
        });

        // Update run with current step status
        const updateResult = await prisma.pipelineRun.update({
          where: { id: runId },
          data: {
            stepResults: stepResults as any
          }
        });

        console.log(`[PipelineRunner] Step status update result:`, {
          runId,
          stepId: stepResult.id,
          updatedStepResults: updateResult.stepResults
        });

        // If this is the source step, use the pipeline repository URL
        const command = step.name === 'Source' 
          ? `git clone ${pipeline.repository} . && git checkout ${branch}`
          : step.command;

        // Execute step
        const result = await this.executeCommand(
          command,
          workspacePath,
          step.environment || {}
        );

        // Update step result
        stepResult.endTime = new Date();
        stepResult.output = result.output;
        
        if (result.error) {
          stepResult.status = 'failed';
          stepResult.error = result.error;
          
          // Add logging for failed step
          console.log(`[PipelineRunner] Step ${stepResult.name} failed:`, {
            runId,
            stepId: stepResult.id,
            status: stepResult.status,
            error: result.error,
            stepResults: JSON.stringify(stepResults)
          });
          
          // Update run as failed
          await prisma.pipelineRun.update({
            where: { id: runId },
            data: {
              status: 'failed',
              completedAt: new Date(),
              stepResults: stepResults as any,
              error: `Step "${step.name}" failed: ${result.error}`
            }
          });

          // Update pipeline status to failed
          await prisma.pipeline.update({
            where: { id: pipeline.id },
            data: { status: 'failed' }
          });
          
          return;
        }

        stepResult.status = 'completed';

        // Add logging for completed step
        console.log(`[PipelineRunner] Step ${stepResult.name} completed:`, {
          runId,
          stepId: stepResult.id,
          status: stepResult.status,
          stepResults: JSON.stringify(stepResults)
        });

        // Update run with completed step status
        await prisma.pipelineRun.update({
          where: { id: runId },
          data: {
            stepResults: stepResults as any
          }
        });
      }

      // Update run as completed
      await prisma.pipelineRun.update({
        where: { id: runId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          stepResults: stepResults as any
        }
      });

      // Update pipeline status to completed
      await prisma.pipeline.update({
        where: { id: pipeline.id },
        data: { status: 'completed' }
      });

    } catch (error: any) {
      console.error('Pipeline execution error:', error);
      
      // Update run with error
      await prisma.pipelineRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          error: error.message
        }
      });

      // Update pipeline status to failed
      await prisma.pipeline.update({
        where: { id: pipeline.id },
        data: { status: 'failed' }
      });
      
      throw error;
    } finally {
      // Cleanup workspace
      if (workspacePath) {
        await this.workspaceService.deleteWorkspace({ path: workspacePath } as any).catch(console.error);
      }
    }
  }
} 