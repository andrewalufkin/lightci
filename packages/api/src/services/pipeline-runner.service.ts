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
import { BillingService } from './billing.service.js';
import { PipelinePreflightService } from './pipeline-preflight.service.js';

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
  private billingService: BillingService;

  constructor(
    private workspaceService: WorkspaceService,
    private prismaClient: PrismaClient = prisma // Default to the global instance
  ) {
    this.billingService = new BillingService(prismaClient);
  }

  private async executeCommand(command: string, workingDir: string, env: Record<string, string> = {}): Promise<{ output: string; error?: string }> {
    try {
      // Check if working directory exists and is writable
      try {
        await fs.access(workingDir, fs.constants.W_OK);
        console.log(`[PipelineRunner] Working directory ${workingDir} is accessible and writable`);
      } catch (error) {
        console.error(`[PipelineRunner] Working directory is not accessible or writable:`, {
          workingDir,
          error: error instanceof Error ? error.message : 'Unknown error',
          stack: error instanceof Error ? error.stack : undefined
        });
        throw new Error(`Working directory ${workingDir} is not accessible or writable: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Log command execution details
      console.log(`[PipelineRunner] Executing command:`, {
        command,
        workingDir,
        environment: Object.keys(env),
        timestamp: new Date().toISOString()
      });

      // Create a clean environment without NODE_OPTIONS
      const cleanEnv = { ...process.env, ...env };
      delete cleanEnv.NODE_OPTIONS;

      // Execute command with timeout and buffer limits
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDir,
        env: cleanEnv,
        timeout: 30 * 60 * 1000, // 30 minute timeout
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for output
      });

      // Log successful execution
      console.log(`[PipelineRunner] Command executed successfully:`, {
        command,
        workingDir,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        timestamp: new Date().toISOString()
      });

      // Log output if it's not too long
      if (stdout.length + stderr.length < 1024) {
        console.log(`[PipelineRunner] Command output:`, {
          stdout,
          stderr
        });
      }

      return { output: stdout + stderr };
    } catch (error: any) {
      // Log detailed error information
      console.error(`[PipelineRunner] Command execution failed:`, {
        command,
        workingDir,
        error: error.message,
        stdout: error.stdout,
        stderr: error.stderr,
        code: error.code,
        signal: error.signal,
        killed: error.killed,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });

      // Return error details
      return { 
        output: (error.stdout || '') + (error.stderr || ''),
        error: `Command failed with exit code ${error.code}${error.signal ? ` (signal: ${error.signal})` : ''}: ${error.message}`
      };
    }
  }

  async runPipeline(pipelineId: string, branch: string, userId: string, commit?: string): Promise<string> {
    // Perform pre-flight checks first
    const preflightService = new PipelinePreflightService(this.prismaClient);
    const preflightResult = await preflightService.performChecks(pipelineId);
    
    // If pre-flight checks fail, throw an error
    if (!preflightResult.canRun) {
      throw new Error(`Cannot run pipeline: ${preflightResult.errors.join(', ')}`);
    }
    
    // Use the pipeline from pre-flight checks
    const pipelineData = preflightResult.pipeline;

    // Check if pipeline has an associated user
    if (!pipelineData.createdById) {
      throw new Error('Pipeline has no associated user');
    }

    // Perform storage check after verifying user association
    const storageCheck = await this.billingService.checkStorageLimit(userId);
    if (!storageCheck.hasEnoughStorage) {
      throw new Error(`Storage limit exceeded: ${storageCheck.remainingMB} MB remaining, but more is required to run the pipeline.`);
    }
    
    // Log any warnings
    if (preflightResult.warnings.length > 0) {
      console.warn(`[PipelineRunner] Pipeline ${pipelineId} has warnings:`, preflightResult.warnings);
    }
    
    // Add workspaceId and cast to PipelineWithSteps
    const pipeline = {
      ...pipelineData,
      workspaceId: 'default'
    } as unknown as PipelineWithSteps;

    // Initialize step results from pipeline steps
    const steps = (typeof pipeline.steps === 'string' ? JSON.parse(pipeline.steps) : pipeline.steps) as PipelineStep[];
    console.log(`[PipelineRunner] Initializing step results from steps:`, {
      pipelineId,
      steps: steps.map(s => ({ id: s.id, name: s.name }))
    });

    const stepResults = steps.map(step => {
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

    // Track this execution
    this.activeExecutions.add(pipelineRun.id);

    console.log(`[PipelineRunner] Starting pipeline execution for run ${pipelineRun.id}`);

    // Execute pipeline immediately in test mode
    if (process.env.NODE_ENV === 'test') {
      return pipelineRun.id;
    }

    // Execute pipeline in non-test mode with proper error handling
    try {
      // Start execution immediately instead of using setImmediate
      this.executePipeline(pipeline, pipelineRun.id, branch)
        .catch(error => {
          console.error(`[PipelineRunner] Pipeline execution failed:`, error);
          // Update pipeline run status to failed
          this.prismaClient.pipelineRun.update({
            where: { id: pipelineRun.id },
            data: {
              status: 'failed',
              error: error instanceof Error ? error.message : 'Unknown error',
              completedAt: new Date()
            }
          }).catch(err => {
            console.error(`[PipelineRunner] Failed to update pipeline run status:`, err);
          });
        })
        .finally(() => {
          // Clean up execution tracking
          this.activeExecutions.delete(pipelineRun.id);
        });

      return pipelineRun.id;
    } catch (error) {
      console.error(`[PipelineRunner] Error starting pipeline execution:`, error);
      throw error;
    }
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
      console.log(`[PipelineRunner] Starting pipeline execution for run ${runId} in directory ${process.cwd()}`);

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
        try {
          // Get workspace
          console.log(`[PipelineRunner] Creating workspace for pipeline ${pipeline.id}`);
          workspace = await this.workspaceService.createWorkspace({
            name: pipeline.name,
            repository: pipeline.repository
          });
          const workspacePath = workspace.path;
          console.log(`[PipelineRunner] Created workspace at ${workspacePath}, checking directory exists...`);
          
          // Verify workspace directory exists and is writable
          try {
            await fs.access(workspacePath, fs.constants.W_OK);
            console.log(`[PipelineRunner] Workspace directory ${workspacePath} is accessible and writable`);
          } catch (error: unknown) {
            console.error(`[PipelineRunner] Workspace directory ${workspacePath} is not accessible:`, error);
            throw new Error(`Failed to access workspace directory: ${error instanceof Error ? error.message : String(error)}`);
          }

          // Parse steps
          const steps = (typeof pipeline.steps === 'string' ? JSON.parse(pipeline.steps) : pipeline.steps) as PipelineStep[];
          console.log(`[PipelineRunner] Starting execution of ${steps.length} steps in workspace ${workspacePath}`);

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
            console.log(`[PipelineRunner] Starting step ${i + 1}/${steps.length}: ${step.name} for run ${runId}`);
            
            const stepResult = stepResults.find(sr => 
              (step.id && sr.id === step.id) ||
              (!step.id && sr.id === step.name)
            );

            if (!stepResult) {
              console.error(`[PipelineRunner] No step result found for step:`, {
                runId,
                stepId: step.id,
                stepName: step.name,
                stepResults: JSON.stringify(stepResults)
              });
              continue;
            }

            // Update step status to running
            stepResult.status = 'running';
            stepResult.startTime = new Date();
            
            console.log(`[PipelineRunner] Updating step status to running:`, {
              runId,
              stepName: step.name,
              stepId: step.id
            });

            await this.prismaClient.pipelineRun.update({
              where: { id: runId },
              data: {
                stepResults: JSON.stringify(stepResults)
              }
            });

            const command = step.name === 'Source' 
              ? `git clone ${pipeline.repository} . && git checkout ${branch}`
              : step.command;

            console.log(`[PipelineRunner] Executing command for step ${step.name}:`, {
              runId,
              command,
              workingDir: workspacePath
            });

            let result: ExecutionResult | undefined;
            try {
              result = await this.executeCommand(command, workspacePath, step.environment || {});
            } catch (error: unknown) {
              console.error(`[PipelineRunner] Step ${step.name} failed:`, {
                runId,
                stepId: step.id,
                error
              });

              // Update step status to failed
              stepResult.status = 'failed';
              stepResult.endTime = new Date();
              stepResult.error = error instanceof Error ? error.message : 'Unknown error';
              stepResult.output = result?.output;

              await this.prismaClient.pipelineRun.update({
                where: { id: runId },
                data: {
                  stepResults: JSON.stringify(stepResults)
                }
              });

              console.log(`[PipelineRunner] Step ${step.name} marked as completed:`, {
                runId,
                stepId: step.id
              });
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

          console.log(`[PipelineRunner] All steps completed successfully for run ${runId}`);

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

          // Track build minutes for billing
          try {
            await this.billingService.trackBuildMinutes(runId);
          } catch (error) {
            console.error(`[PipelineRunner] Error tracking build minutes:`, error);
            // Don't fail the pipeline run if billing tracking fails
          }
        } catch (error) {
          console.error(`[PipelineRunner] Error in execution promise:`, error);
          throw error;
        }
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

      // Track build minutes for billing even if the pipeline failed
      try {
        await this.billingService.trackBuildMinutes(runId);
      } catch (billingError) {
        console.error(`[PipelineRunner] Error tracking build minutes for failed pipeline:`, billingError);
        // Don't fail the pipeline run if billing tracking fails
      }

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
      // Get pipeline with project data
      const pipelineWithProject = await this.prismaClient.pipeline.findUnique({
        where: { id: pipeline.id },
        include: { project: true }
      });

      if (!pipelineWithProject) {
        throw new Error(`Pipeline ${pipeline.id} not found`);
      }

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
      const artifactsBaseDir = process.env.ARTIFACTS_PATH || '/tmp/lightci/artifacts';
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

      // Create a usage record for the total artifact storage
      const sizeInMB = totalSize / (1024 * 1024); // Convert bytes to MB
      
      // Create a usage record directly
      await this.prismaClient.$executeRaw`
        INSERT INTO usage_records (
          id, 
          usage_type, 
          quantity, 
          storage_change, 
          pipeline_run_id, 
          project_id, 
          user_id, 
          metadata
        ) VALUES (
          ${crypto.randomUUID()}, 
          'artifact_storage', 
          ${sizeInMB}, 
          ${totalSize}, 
          ${runId}, 
          ${pipelineWithProject.project?.id || null}, 
          ${pipelineWithProject.createdById || null}, 
          ${'{"action":"created","artifact_count":' + artifactsCount + ',"storage_type":"' + pipelineWithProject.artifactStorageType + '"}'}
        )
      `;
      
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