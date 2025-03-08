import { PrismaClient } from '@prisma/client';
import { WorkspaceService } from './workspace.service.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import { glob } from 'glob';
import { DeploymentService, DeploymentConfig } from './deployment.service.js';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { PipelineStateService } from './pipeline-state.service.js';
import { PipelineWithSteps, PipelineStep } from '../models/Pipeline.js';
import { prisma } from '../lib/prisma.js';
import { Step } from '../models/Step.js';

const execAsync = promisify(exec);

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

interface ExecutionResult {
  output: string;
  error?: string;
}

// Update the status type to include 'running'
interface PipelineStepResult extends Step {
  id: string;
  name: string;
  command: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  environment: Record<string, string>;
  runLocation: 'local' | 'deployed';
  runOnDeployedInstance: boolean;
  startTime?: Date;
  endTime?: Date;
  output?: string;
  error?: string;
}

export class PipelineRunnerService {
  private activeTimeouts: NodeJS.Timeout[] = [];
  private activeExecutions: Set<string> = new Set();

  constructor(
    private workspaceService: WorkspaceService,
    private prismaClient: PrismaClient = prisma // Default to the global instance
  ) {}

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
    const pipelineData = await this.prismaClient.pipeline.findUnique({
      where: { id: pipelineId }
    });

    if (!pipelineData) {
      throw new Error('Pipeline not found');
    }

    // Add workspaceId and cast to PipelineWithSteps
    const pipeline = {
      ...pipelineData,
      workspaceId: 'default' // Add workspaceId directly since it doesn't exist on pipelineData
    } as unknown as PipelineWithSteps;

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
        status: 'pending' as PipelineStepResult['status'],
        environment: step.environment || {},
        runLocation: (step.runLocation || 'local') as 'local' | 'deployed',
        runOnDeployedInstance: step.runOnDeployedInstance || false,
        startTime: undefined as Date | undefined,
        endTime: undefined as Date | undefined,
        output: undefined as string | undefined,
        error: undefined as string | undefined
      };
    });

    console.log(`[PipelineRunner] Created step results:`, {
      pipelineId,
      stepResults: stepResults.map(sr => ({ id: sr.id, name: sr.name }))
    });

    // Create pipeline run
    const pipelineRun = await this.prismaClient.pipelineRun.create({
      data: {
        pipeline: {
          connect: { id: pipelineId }
        },
        branch,
        commit,
        status: 'running',
        stepResults: JSON.stringify(stepResults),
        logs: []
      }
    });

    // Update pipeline status to running
    await this.prismaClient.pipeline.update({
      where: { id: pipelineId },
      data: { status: 'running' }
    });

    // In test mode, don't run the pipeline asynchronously to avoid hanging
    if (process.env.NODE_ENV === 'test') {
      // For tests, we just return the run ID without actually executing the pipeline
      // This prevents hanging due to background processes during tests
      return pipelineRun.id;
    }

    // Track this execution
    this.activeExecutions.add(pipelineRun.id);

    // Run the pipeline asynchronously in non-test environments
    this.executePipeline(pipeline, pipelineRun.id, branch)
      .catch(error => {
        console.error('Pipeline execution error:', error);
      })
      .finally(() => {
        // Remove from active executions when done
        this.activeExecutions.delete(pipelineRun.id);
      });

    return pipelineRun.id;
  }

  private async handleDeployment(pipeline: PipelineWithSteps, runId: string) {
    console.log(`[PipelineRunner] Starting deployment process for pipeline ${pipeline.id}, run ${runId}`);
    
    // Create a valid base DeploymentConfig
    const baseConfig: DeploymentConfig = {
      platform: pipeline.deploymentPlatform || 'default',
      config: {}
    };

    // Properly structure the deployment config
    let deployConfig: DeploymentConfig;
    
    if (typeof pipeline.deploymentConfig === 'object' && pipeline.deploymentConfig) {
      deployConfig = {
        platform: (pipeline.deploymentConfig as any).platform || baseConfig.platform,
        config: (pipeline.deploymentConfig as any).config || {}
      };
    } else {
      deployConfig = baseConfig;
    }
    
    console.log(`[PipelineRunner] Deployment configuration:`, deployConfig);

    const deploymentService = new DeploymentService();
    console.log(`[PipelineRunner] Created deployment service instance`);
    
    const deployResult = await deploymentService.deployPipelineRun(runId, deployConfig);
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
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      // Set up timeout
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('Pipeline execution timeout'));
        }, PipelineStateService.PIPELINE_TIMEOUT_MS);
        
        // Track this timeout
        this.activeTimeouts.push(timeoutId);
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
        const stepResults = steps.map(step => ({
          id: step.id || '',
          name: step.name,
          command: step.command,
          status: 'pending' as PipelineStepResult['status'],
          environment: step.environment || {},
          runLocation: (step.runLocation || 'local') as 'local' | 'deployed',
          runOnDeployedInstance: step.runOnDeployedInstance || false,
          startTime: undefined as Date | undefined,
          endTime: undefined as Date | undefined,
          output: undefined as string | undefined,
          error: undefined as string | undefined
        }));

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

          // Use type assertion to ensure TypeScript understands we can set this to 'running'
          stepResult.status = 'running';
          stepResult.startTime = new Date();

          await this.prismaClient.pipelineRun.update({
            where: { id: runId },
            data: {
              stepResults: JSON.stringify(stepResults)
            }
          });

          const command = step.name === 'Source' 
            ? `git clone ${pipeline.repository} . && git checkout ${branch}`
            : step.command;

          let result: ExecutionResult;
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
            
            // Ensure deploymentConfig is properly structured
            let deploymentConfig: DeploymentConfig;
            if (typeof pipeline.deploymentConfig === 'object' && pipeline.deploymentConfig) {
              deploymentConfig = {
                platform: (pipeline.deploymentConfig as any).platform || 'default',
                config: (pipeline.deploymentConfig as any).config || {}
              };
            } else {
              deploymentConfig = {
                platform: 'default',
                config: {}
              };
            }
            
            result = await this.executeOnDeployedInstance(
              command,
              deploymentConfig,
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

          if ('error' in result && result.error) {
            // Update the step status to failed before throwing the error
            const failedStep: PipelineStepResult = {
              id: step.id || '',
              name: step.name,
              command: step.command,
              status: 'failed',
              environment: step.environment || {},
              runLocation: (step.runLocation || 'local') as 'local' | 'deployed',
              runOnDeployedInstance: step.runOnDeployedInstance || false,
              startTime: stepResult.startTime,
              endTime: new Date(),
              output: result.output,
              error: result.error
            };

            // Update the pipeline run with the failed step
            await this.prismaClient.pipelineRun.update({
              where: { id: runId },
              data: {
                stepResults: JSON.stringify([failedStep]),
                error: result.error
              }
            });

            throw new Error(result.error);
          }

          await this.updateStepStatus(runId, step.id || '', 'completed', stepResults, result.output);

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

        await this.prismaClient.pipelineRun.update({
          where: { id: runId },
          data: {
            status: 'completed',
            completedAt: new Date()
          }
        });

        await this.prismaClient.pipeline.update({
          where: { id: pipeline.id },
          data: { status: 'completed' }
        });
      })();

      // Race between execution and timeout
      await Promise.race([executionPromise, timeoutPromise]);

    } catch (error) {
      console.error(`[PipelineRunner] Error executing pipeline:`, error);

      // Update pipeline and run status to failed
      await this.prismaClient.pipelineRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          completedAt: new Date(),
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      });

      await this.prismaClient.pipeline.update({
        where: { id: pipeline.id },
        data: { status: 'failed' }
      });

      throw error;
    } finally {
      // Clear the timeout
      if (timeoutId) {
        clearTimeout(timeoutId);
        const index = this.activeTimeouts.indexOf(timeoutId);
        if (index !== -1) {
          this.activeTimeouts.splice(index, 1);
        }
      }

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
      const run = await this.prismaClient.pipelineRun.findUnique({
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
      await this.prismaClient.pipelineRun.update({
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
      await this.prismaClient.pipelineRun.update({
        where: { id: runId },
        data: {
          error: `Failed to collect artifacts: ${error instanceof Error ? error.message : 'Unknown error'}`
        }
      });
    }
  }

  // Helper method to execute commands on the deployed instance
  private async executeOnDeployedInstance(
    command: string,
    deploymentConfig: DeploymentConfig,
    environment: Record<string, string> = {}
  ): Promise<{ output: string; error?: string }> {
    try {
      // Parse config if it's a string
      const config = typeof deploymentConfig === 'string' 
        ? JSON.parse(deploymentConfig) 
        : deploymentConfig.config; // Use the config property from DeploymentConfig
      
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
    status: PipelineStepResult['status'],
    stepResults: PipelineStepResult[],
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
    await this.prismaClient.pipelineRun.update({
      where: { id: runId },
      data: {
        stepResults: JSON.stringify(stepResults)
      }
    });
  }

  // Add a cleanup method to terminate all background processes
  async cleanup(): Promise<void> {
    console.log('[PipelineRunnerService] Cleaning up resources...');
    
    // Clear all timeouts
    for (const timeout of this.activeTimeouts) {
      clearTimeout(timeout);
    }
    this.activeTimeouts = [];
    
    // Mark all active executions as completed to prevent further processing
    this.activeExecutions.clear();
    
    console.log('[PipelineRunnerService] Cleanup completed');
  }
}