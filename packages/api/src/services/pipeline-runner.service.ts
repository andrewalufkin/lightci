import { PrismaClient } from '@prisma/client';
import { WorkspaceService } from './workspace.service';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import { glob } from 'glob';
import { DeploymentService } from './deployment.service';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { PipelineStateService } from './pipeline-state.service';
import { PipelineWithSteps, PipelineStep, StepResult } from '../models/Pipeline';
import { prisma } from '../db';

const execAsync = promisify(exec);
const prismaClient = new PrismaClient();

interface WorkspaceConfig {
  name: string;
  repository: string;
}

interface Workspace {
  id: string;
  name: string;
  repository: string;
  path: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ArtifactConfig {
  patterns?: string[];
  retentionDays?: number;
  enabled?: boolean;
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
    const pipeline = await prismaClient.pipeline.findUnique({
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
    const pipelineRun = await prismaClient.pipelineRun.create({
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
    await prismaClient.pipeline.update({
      where: { id: pipelineId },
      data: { status: 'running' }
    });

    // Run the pipeline asynchronously
    this.executePipeline(pipeline, pipelineRun.id, branch).catch(error => {
      console.error('Pipeline execution error:', error);
    });

    return pipelineRun.id;
  }

  private async handleDeployment(pipeline: PipelineWithSteps, runId: string) {
    console.log(`[PipelineRunner] Starting deployment process for pipeline ${pipeline.id}, run ${runId}`);
    console.log(`[PipelineRunner] Deployment configuration:`, {
      platform: pipeline.deploymentPlatform,
      enabled: pipeline.deploymentEnabled,
      config: pipeline.deploymentConfig
    });

    const deploymentService = new DeploymentService();
    console.log(`[PipelineRunner] Created deployment service instance`);
    
    const deployResult = await deploymentService.deployPipelineRun(runId);
    console.log(`[PipelineRunner] Deployment result:`, {
      success: deployResult.success,
      message: deployResult.message,
      logCount: deployResult.logs?.length || 0
    });
    
    if (!deployResult.success) {
      console.error(`[PipelineRunner] Deployment failed:`, deployResult.message);
      throw new Error(deployResult.message);
    }
    
    console.log(`[PipelineRunner] Deployment completed successfully`);
    return { output: deployResult.message || 'Deployment successful' };
  }

  private async executePipeline(pipeline: PipelineWithSteps, runId: string, branch: string): Promise<void> {
    let workspace: Workspace | undefined;
    let deploymentCompleted = false;

    try {
      // Set up timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Pipeline execution timeout'));
        }, PipelineStateService.PIPELINE_TIMEOUT_MS);
      });

      // Create the execution promise
      const executionPromise = (async () => {
        // Get workspace
        workspace = await this.workspaceService.createWorkspace({
          name: pipeline.name,
          repository: pipeline.repository
        });
        const workspacePath = workspace.path;
        console.log(`[PipelineRunner] Created workspace at ${workspacePath}`);

        // Parse steps
        const steps = (typeof pipeline.steps === 'string' ? JSON.parse(pipeline.steps) : pipeline.steps) as PipelineStep[];
        console.log(`[PipelineRunner] Parsed steps:`, {
          runId,
          steps: steps.map(s => ({ 
            id: s.id, 
            name: s.name,
            runLocation: s.runLocation,
            runOnDeployedInstance: s.runOnDeployedInstance
          }))
        });

        // Initialize step results
        const stepResults = steps.map(step => {
          const stepId = step.id || step.name;
          return {
            id: stepId,
            name: step.name,
            command: step.command,
            status: 'pending' as StepResult['status'],
            environment: step.environment || {},
            runLocation: step.runLocation,
            runOnDeployedInstance: step.runOnDeployedInstance,
            startTime: undefined as Date | undefined,
            endTime: undefined as Date | undefined,
            output: undefined as string | undefined,
            error: undefined as string | undefined
          };
        });

        // Execute each step
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const stepResult = stepResults.find(sr => 
            (step.id && sr.id === step.id) ||
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

          stepResult.status = 'running';
          stepResult.startTime = new Date();

          await prismaClient.pipelineRun.update({
            where: { id: runId },
            data: {
              stepResults: stepResults as any
            }
          });

          const command = step.name === 'Source' 
            ? `git clone ${pipeline.repository} . && git checkout ${branch}`
            : step.command;

          let result;
          // Check if this is a deployment step
          if (step.name === 'Deploy' || step.name === 'Deployment' || step.type === 'deploy') {
            console.log(`[PipelineRunner] Handling deployment step ${step.name}:`, {
              runId,
              stepId: step.id,
              type: step.type,
              name: step.name
            });
            result = await this.handleDeployment(pipeline, runId);
            deploymentCompleted = true;
          } 
          // Check if this step should run on deployed instance
          else if (deploymentCompleted && (
            step.runLocation === 'deployed' || 
            step.runOnDeployedInstance === true || 
            (pipeline.deploymentEnabled && pipeline.deploymentConfig)
          )) {
            console.log(`[PipelineRunner] Executing step ${step.name} on deployed instance:`, {
              runId,
              stepId: step.id,
              runLocation: step.runLocation,
              runOnDeployedInstance: step.runOnDeployedInstance,
              deploymentEnabled: pipeline.deploymentEnabled
            });
            result = await this.executeOnDeployedInstance(
              command,
              pipeline.deploymentConfig,
              step.environment || {}
            );
          } else {
            console.log(`[PipelineRunner] Executing step ${step.name} locally:`, {
              runId,
              stepId: step.id,
              runLocation: step.runLocation,
              runOnDeployedInstance: step.runOnDeployedInstance,
              deploymentEnabled: pipeline.deploymentEnabled
            });
            result = await this.executeCommand(
              command,
              workspacePath,
              step.environment || {}
            );
          }

          if (result.error) {
            // Update the step status to failed before throwing the error
            stepResult.status = 'failed';
            stepResult.error = result.error;
            stepResult.output = result.output;
            stepResult.endTime = new Date();

            // Update the pipeline run with the failed step
            await prismaClient.pipelineRun.update({
              where: { id: runId },
              data: {
                stepResults: stepResults as any,
                error: result.error
              }
            });

            throw new Error(result.error);
          }

          await this.updateStepStatus(runId, step.id, 'completed', stepResults, result.output);

          if (step.name === 'Build') {
            await this.collectArtifacts(pipeline, runId, workspacePath);
          }
        }

        // After all steps complete successfully
        if (workspacePath) {
          try {
            await this.collectArtifacts(pipeline, runId, workspacePath);
          } catch (error) {
            console.error(`[PipelineRunner] Failed to collect artifacts:`, error);
          }
        }

        await prismaClient.pipelineRun.update({
          where: { id: runId },
          data: {
            status: 'completed',
            completedAt: new Date()
          }
        });

        await prismaClient.pipeline.update({
          where: { id: pipeline.id },
          data: { status: 'completed' }
        });
      })();

      // Race between execution and timeout
      await Promise.race([executionPromise, timeoutPromise]);

    } catch (error) {
      console.error(`[PipelineRunner] Error executing pipeline:`, error);

      // Update pipeline and run status to failed
      await prismaClient.pipelineRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      });

      await prismaClient.pipeline.update({
        where: { id: pipeline.id },
        data: { status: 'failed' }
      });

      throw error;
    } finally {
      // Clean up workspace
      if (workspace) {
        try {
          await this.workspaceService.deleteWorkspace(workspace);
        } catch (error) {
          console.error(`[PipelineRunner] Error cleaning up workspace:`, error);
        }
      }
    }
  }

  private async collectArtifacts(
    pipeline: PipelineWithSteps, 
    runId: string, 
    workspacePath: string
  ): Promise<void> {
    try {
      // Check if artifacts have already been collected for this run
      const run = await prismaClient.pipelineRun.findUnique({
        where: { id: runId }
      });

      if (run?.artifactsCollected) {
        console.log(`[PipelineRunner] Artifacts already collected for run ${runId}, skipping collection`);
        return;
      }

      console.log(`[PipelineRunner] Starting artifact collection for run ${runId}`);
      
      // Default artifact patterns
      const defaultPatterns = [
        '**/dist/**',           // Distribution files
        '**/build/**',          // Build output
        '**/src/**',            // Source code files
        '**/package.json',      // Package configuration in any directory
        './package.json',       // Root package.json
        'package.json',         // Alternative root package.json pattern
        '**/.env*',             // Environment configuration files
        '**/scripts/**',        // Script directories
        '**/*.sh',              // Shell scripts
        '**/bin/**',            // Binary/executable scripts
        '**/docker-compose*',   // Docker compose files
        '**/Dockerfile*',       // Dockerfile configurations
        '**/config/**'          // Configuration directories
      ];

      // Get configured patterns and combine with defaults
      const configuredPatterns = pipeline.artifactConfig?.patterns || [];
      const artifactPatterns = Array.from(new Set([...defaultPatterns, ...configuredPatterns]));

      console.log(`[PipelineRunner] Using artifact patterns:`, {
        defaultPatterns,
        configuredPatterns,
        combinedPatterns: artifactPatterns
      });
      
      // Create artifacts directory structure
      const artifactsBaseDir = process.env.ARTIFACTS_ROOT || '/tmp/lightci/artifacts';
      const runArtifactsDir = path.join(artifactsBaseDir, runId);
      
      // Ensure directory exists and is empty
      await fs.rm(runArtifactsDir, { recursive: true, force: true });
      await fs.mkdir(runArtifactsDir, { recursive: true });
      
      console.log(`[PipelineRunner] Created artifacts directory: ${runArtifactsDir}`);
      
      let artifactsCount = 0;
      let totalSize = 0;
      
      // Process each pattern
      for (const pattern of artifactPatterns) {
        console.log(`[PipelineRunner] Processing pattern: ${pattern}`);
        
        // Use glob to find matching files
        const files = await glob(pattern, {
          cwd: workspacePath,
          dot: true,
          nodir: true,
          absolute: false,
          ignore: [
            '**/node_modules/**',
            '**/.git/**',
            '**/coverage/**',
            '**/tmp/**'
          ]
        });
        
        // Copy each file to artifacts directory, preserving relative paths
        for (const file of files) {
          const sourcePath = path.join(workspacePath, file);
          const destPath = path.join(runArtifactsDir, file);
          
          try {
            // Create directory structure for the destination
            await fs.mkdir(path.dirname(destPath), { recursive: true });
            
            // Copy file
            await fs.copyFile(sourcePath, destPath);
            
            // Get file size
            const stats = await fs.stat(sourcePath);
            totalSize += stats.size;
            artifactsCount++;
            
            console.log(`[PipelineRunner] Copied artifact: ${file} (${stats.size} bytes)`);
          } catch (error) {
            console.error(`[PipelineRunner] Error copying artifact ${file}:`, error);
            // Continue with other files even if one fails
          }
        }
      }
      
      // Calculate expiration date (default 30 days if not specified)
      const retentionDays = pipeline.artifactConfig?.retentionDays || 30;
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + retentionDays);
      
      // Record artifact information in database
      await prismaClient.pipelineRun.update({
        where: { id: runId },
        data: {
          artifactsCollected: true,
          artifactsPath: runArtifactsDir,
          artifactsCount: artifactsCount,
          artifactsSize: totalSize,
          artifactsExpireAt: expiresAt
        }
      });
      
      console.log(`[PipelineRunner] Successfully collected ${artifactsCount} artifacts (${totalSize} bytes) for run ${runId}`);
      
    } catch (error) {
      console.error(`[PipelineRunner] Error collecting artifacts:`, error);
      // Update pipeline run with error information but don't throw
      await prismaClient.pipelineRun.update({
        where: { id: runId },
        data: {
          error: `Failed to collect artifacts: ${error.message}`
        }
      });
    }
  }

  // Helper method to execute commands on the deployed instance
  private async executeOnDeployedInstance(
    command: string,
    deploymentConfig: any,
    environment: Record<string, string> = {}
  ): Promise<{ output: string; error?: string }> {
    try {
      // Parse config if it's a string
      const config = typeof deploymentConfig === 'string' ? JSON.parse(deploymentConfig) : deploymentConfig;
      
      if (!config.awsAccessKeyId || !config.awsSecretAccessKey || !config.awsRegion) {
        throw new Error('Missing required AWS credentials');
      }

      // Create new EC2 client with credentials
      const ec2Client = new EC2Client({
        region: config.awsRegion,
        credentials: {
          accessKeyId: config.awsAccessKeyId,
          secretAccessKey: config.awsSecretAccessKey
        }
      });

      // Get instance details
      const describeCommand = new DescribeInstancesCommand({
        InstanceIds: [config.ec2InstanceId]
      });
      const instanceData = await ec2Client.send(describeCommand);

      const instance = instanceData.Reservations?.[0]?.Instances?.[0];
      if (!instance || !instance.PublicDnsName) {
        throw new Error(`Unable to find public DNS for instance ${config.ec2InstanceId}`);
      }

      // Create temporary directory for SSH key
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lightci-ssh-'));
      const keyPath = path.join(tempDir, 'ssh_key.pem');

      try {
        // Write SSH key to temporary file
        await fs.writeFile(keyPath, config.ec2SshKey, { mode: 0o600 });

        // Build environment variables string
        const envString = Object.entries(environment)
          .map(([key, value]) => `export ${key}="${value}"`)
          .join(' && ');

        // Add cleanup command to kill any existing processes on port 3000
        const cleanupCmd = `sudo lsof -t -i:3000 | xargs -r sudo kill -9`;
        
        // Append '&' to run in background and redirect output to nohup.out
        const backgroundCommand = `nohup ${command} > nohup.out 2>&1 &`;
        
        // Execute command via SSH with cleanup and background execution
        const sshCommand = `ssh -o StrictHostKeyChecking=no -i "${keyPath}" ${config.ec2Username}@${instance.PublicDnsName} "${cleanupCmd} 2>/dev/null || true && cd ${config.ec2DeployPath || '/home/ec2-user/app'} && ${envString} ${envString ? '&&' : ''} (${backgroundCommand}) && echo 'Process started in background'"`;

        try {
          const { stdout, stderr } = await execAsync(sshCommand);
          await fs.rm(tempDir, { recursive: true });
          
          if (stderr) {
            return { output: stdout, error: stderr };
          }
          return { output: stdout };
        } catch (error: any) {
          await fs.rm(tempDir, { recursive: true });
          return { 
            output: error.stdout || '',
            error: error.stderr || error.message 
          };
        }
      } catch (error: any) {
        // Clean up temp directory on error
        await fs.rm(tempDir, { recursive: true }).catch(() => {});
        throw error;
      }
    } catch (error: any) {
      console.error('[PipelineRunner] Execution on deployed instance failed:', error);
      throw error;
    }
  }

  private async updateStepStatus(
    runId: string,
    stepId: string,
    status: StepResult['status'],
    stepResults: StepResult[],
    output: string
  ): Promise<void> {
    const stepResult = stepResults.find(sr => sr.id === stepId);
    if (!stepResult) {
      throw new Error(`Step result not found for step ID: ${stepId}`);
    }

    stepResult.status = status;
    stepResult.endTime = new Date();
    stepResult.output = output;

    // Update run with completed step status
    await prismaClient.pipelineRun.update({
      where: { id: runId },
      data: {
        stepResults: stepResults as any
      }
    });
  }
}