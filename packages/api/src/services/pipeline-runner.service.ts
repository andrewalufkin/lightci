import { PrismaClient } from '@prisma/client';
import { WorkspaceService } from './workspace.service.js';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { glob } from 'glob';
import { DeploymentConfig, DeploymentService } from './deployment.service.js';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { PipelineStateService } from './pipeline-state.service.js';
import { PipelineWithSteps, PipelineStep } from '../models/Pipeline.js';
import { prisma } from '../lib/prisma.js';
import { Step } from '../models/Step.js';
import { BillingService } from './billing.service.js';
import { PipelinePreflightService } from './pipeline-preflight.service.js';
import { EngineService } from './engine.service.js';
import { existsSync, statSync } from 'fs';
import { mkdtemp, unlink, rm } from 'fs/promises';
import { NodeSSH } from 'node-ssh';
import { mkdir } from 'fs/promises';
import { writeFile } from 'fs/promises';
import { readFile } from 'fs/promises';
import * as fsPromises from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import globby from 'globby';
import { rimraf } from 'rimraf';
import { CloudTasksService } from './cloud-tasks.service.js';
import { InstanceProvisionerService } from './instance-provisioner.service.js';
import { SshKeyService } from './ssh-key.service.js';
import { RunStorageService } from './run-storage.service.js';

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

// Add a list of dangerous patterns to block
const DANGEROUS_PATTERNS = [
  // Fork bombs
  /:\(\)\s*{\s*:\|\s*:\s*&\s*}\s*;:/i,             // :(){ :|: & };:
  /\(\)\s*{\s*\|\s*&\s*};\s*\(\)/i,                // (){ |& }; ()
  // Recursion that could cause resource exhaustion
  /\(\)\s*{\s*.*\(\)\s*}\s*;\s*\(\)/i,             // Generic recursion detection
  // Dangerous commands
  /\brm\s+(-rf?|--recursive|--force)\s+[\/\*]/i,   // rm -rf / or similar
  /\bmkfs\b/i,                                     // mkfs
  /\bdd\b.*if=.*of=\/dev\/(hd|sd|mmcblk)/i,        // Disk destroyer
  /\bchmod\s+-R\s+777\s+\//i,                      // chmod -R 777 /
  // Shell escapes
  /\b(wget|curl)\b.*\|\s*(bash|sh)/i,              // wget/curl | bash
  // Disrupt system operation
  />\s*\/dev\/sda/i,                               // > /dev/sda
  /\bfill\b.*\/dev\/sd/i,                          // fill /dev/sd
  // System modification
  /\bsystemctl\s+(stop|disable)\s+\w/i,            // systemctl stop
  // Command chaining that might hide malicious commands
  /(`|\$\()\s*.*?(rm|mkfs|dd|chmod)\s/i            // Command substitution with dangerous commands
];

// Define DeploymentPlatform type if it's not exported
type DeploymentPlatform = 'aws' | 'aws_ec2' | 'aws_ecs' | 'gcp' | 'azure' | 'kubernetes' | 'custom';

export class PipelineRunnerService {
  private activeTimeouts: NodeJS.Timeout[] = [];
  private activeExecutions: Set<string>;
  private workspaceService: WorkspaceService;
  private prismaClient: PrismaClient;
  private billingService: BillingService;
  private engineService: EngineService;
  private deploymentService: DeploymentService;
  private preflightService: PipelinePreflightService;
  private sshKeyService: SshKeyService;
  private runStorageService: RunStorageService;

  constructor(
    prismaClient: PrismaClient = prisma,
    engineService: EngineService = new EngineService(process.env.CORE_ENGINE_URL || 'http://localhost:3001'),
    workspaceService: WorkspaceService = new WorkspaceService(),
    sshKeyService?: SshKeyService,
    runStorageService?: RunStorageService
  ) {
    this.prismaClient = prismaClient;
    this.engineService = engineService;
    this.workspaceService = workspaceService;
    this.activeExecutions = new Set();
    this.billingService = new BillingService(prismaClient);
    this.preflightService = new PipelinePreflightService(prismaClient, this.billingService);
    this.deploymentService = new DeploymentService(prismaClient, engineService, sshKeyService);
    this.runStorageService = runStorageService || new RunStorageService();
    this.sshKeyService = sshKeyService || new SshKeyService(prismaClient);
  }

  /**
   * Validates and sanitizes command input to prevent dangerous operations
   * @param command The command to validate
   * @returns A validated command or throws an error if dangerous
   */
  private validateCommand(command: string): string {
    // Trim the command to remove leading/trailing whitespace
    const trimmedCommand = command.trim();
    
    // Check for empty commands
    if (!trimmedCommand) {
      throw new Error('Empty command is not allowed');
    }
    
    // Check against dangerous patterns
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(trimmedCommand)) {
        throw new Error('Potentially dangerous command detected and blocked for security reasons');
      }
    }
    
    // Check for attempts to run commands with elevated privileges
    if (/\bsudo\b|\bsu\b|\bdoas\b/.test(trimmedCommand)) {
      throw new Error('Elevated privilege commands are not allowed');
    }
    
    // Block attempts to download and execute scripts
    if (/\bcurl\b.*\|\s*(bash|sh)|wget.*\|\s*(bash|sh)/.test(trimmedCommand)) {
      throw new Error('Downloading and executing scripts is not allowed');
    }
    
    return trimmedCommand;
  }

  private async executeCommand(command: string, workingDir: string, env: Record<string, string> = {}): Promise<{ output: string; error?: string }> {
    try {
      // Validate the command before executing
      const validatedCommand = this.validateCommand(command);
      
      // Check if working directory exists and is writable
      try {
        await fsPromises.access(workingDir, fsPromises.constants.W_OK);
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
        command: validatedCommand,
        workingDir,
        environment: Object.keys(env),
        timestamp: new Date().toISOString()
      });

      // Create a clean environment without NODE_OPTIONS
      const cleanEnv = { ...process.env, ...env };
      delete cleanEnv.NODE_OPTIONS;

      // Execute command with timeout and buffer limits
      const { stdout, stderr } = await execAsync(validatedCommand, {
        cwd: workingDir,
        env: cleanEnv,
        timeout: 30 * 60 * 1000, // 30 minute timeout
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for output
      });

      // Log successful execution
      console.log(`[PipelineRunner] Command executed successfully:`, {
        command: validatedCommand,
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
        command, // Use original command - validatedCommand might not be available if validation failed
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

  async runPipeline(pipelineId: string, branch: string, userId: string, commit?: string, existingRunId?: string): Promise<string> {
    // Perform pre-flight checks first
    const preflightResult = await this.preflightService.performChecks(pipelineId);
    
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

    let pipelineRun;
    if (existingRunId) {
      // Update existing run with step results
      pipelineRun = await this.prismaClient.pipelineRun.update({
        where: { id: existingRunId },
        data: {
          stepResults: JSON.stringify(stepResults),
          status: 'running'
        }
      });
      console.log(`[PipelineRunner] Updated existing pipeline run ${existingRunId} with step results`);
    } else {
      // Create new pipeline run
      pipelineRun = await this.prismaClient.pipelineRun.create({
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
      console.log(`[PipelineRunner] Created new pipeline run ${pipelineRun.id}`);
    }

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

    const deploymentService = new DeploymentService(this.engineService);
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

  private async executePipeline(
    pipeline: PipelineWithSteps,
    runId: string,
    branch: string
  ): Promise<void> {
    let workspace: Workspace | undefined;
    let deploymentCompleted = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let deployedInstanceConfig: DeploymentConfig | undefined;

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
            await fsPromises.access(workspacePath, fsPromises.constants.W_OK);
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
              ? this.buildSourceCommand(pipeline.repository, branch)
              : step.command;

            console.log(`[PipelineRunner] Executing command for step ${step.name}:`, {
              runId,
              command,
              workingDir: workspacePath,
              runLocation: step.runLocation
            });

            let result: ExecutionResult | undefined;
            try {
              // If step should run on deployed instance
              if (step.runLocation === 'deployed_instance') {
                // Collect artifacts before deployment if they haven't been collected yet
                if (!deploymentCompleted && workspacePath) {
                  try {
                    await this.collectArtifacts(pipeline, runId, workspacePath);
                  } catch (error) {
                    console.error(`[PipelineRunner] Error collecting artifacts before deployment:`, error);
                    throw error;
                  }
                }

                // If deployment hasn't completed yet, trigger it
                if (!deploymentCompleted) {
                  console.log(`[PipelineRunner] Step requires deployed instance, triggering deployment...`);
                  const deploymentService = new DeploymentService(this.engineService);
                  
                  // Create deployment configuration
                  const deploymentConfig: DeploymentConfig = {
                    platform: pipeline.deploymentPlatform as DeploymentPlatform || 'aws',
                    config: {
                      // Only include necessary properties from the original config
                      // instead of spreading the entire object which can be too large
                      service: 'ec2',
                      region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
                      instanceType: 't2.micro',
                      runLocation: 'deployed_instance',
                      securityGroupIds: [process.env.AWS_SECURITY_GROUP_ID],
                      subnetId: process.env.AWS_SUBNET_ID
                    },
                    mode: pipeline.deploymentMode || 'automatic',
                    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
                    region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
                    pipelineId: pipeline.id
                  };

                  // Make a deep copy to avoid reference issues
                  const deepCopyConfig = JSON.parse(JSON.stringify(deploymentConfig));
                  
                  // Carefully extract any SSH keys from the original config and add them directly to avoid JSON stringify issues
                  if (typeof pipeline.deploymentConfig === 'object' && pipeline.deploymentConfig !== null) {
                    const originalConfig = pipeline.deploymentConfig as Record<string, any>;
                    
                    // Extract keys directly without going through JSON.stringify to preserve formatting
                    if (originalConfig.ec2SshKey) {
                      deepCopyConfig.ec2SshKey = originalConfig.ec2SshKey;
                      console.log(`[PipelineRunner] Preserved original SSH key (${originalConfig.ec2SshKey.length} chars)`);
                    }
                    
                    if (originalConfig.ec2SshKeyEncoded) {
                      deepCopyConfig.ec2SshKeyEncoded = originalConfig.ec2SshKeyEncoded;
                      console.log(`[PipelineRunner] Preserved original encoded SSH key (${originalConfig.ec2SshKeyEncoded.length} chars)`);
                    }
                  }
                  
                  // Trigger deployment
                  const deployResult = await deploymentService.deployPipelineRun(runId, deepCopyConfig);
                  if (!deployResult.success) {
                    throw new Error(`Deployment failed: ${deployResult.message}`);
                  }
                  
                  console.log(`[PipelineRunner] Deployment completed successfully`);
                  deploymentCompleted = true;
                  
                  // Fetch the deployed app record to get instance information
                  const deployedApp = await this.prismaClient.deployedApp.findFirst({
                    where: { pipelineId: pipeline.id },
                    orderBy: { lastDeployed: 'desc' }
                  });
                  
                  if (!deployedApp) {
                    throw new Error('Deployment record not found after successful deployment');
                  }
                  
                  // Look up the most recent auto-deployment for this pipeline
                  const autoDeployment = await this.prismaClient.autoDeployment.findFirst({
                    where: { 
                      pipelineId: pipeline.id,
                      status: 'active' 
                    },
                    orderBy: { createdAt: 'desc' }
                  });
                  
                  // Create/update the deployment config for subsequent steps
                  deployedInstanceConfig = {
                    ...deepCopyConfig,
                    instanceId: autoDeployment?.instanceId || '',
                    publicDns: deployedApp.url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
                  };
                  
                  console.log(`[PipelineRunner] Saved instance details for future steps:`, {
                    instanceId: deployedInstanceConfig.instanceId,
                    publicDns: deployedInstanceConfig.publicDns
                  });
                  
                  // Extract key name from auto deployment metadata if available
                  let keyName = '';
                  if (autoDeployment?.metadata) {
                    try {
                      const metadata = typeof autoDeployment.metadata === 'string' 
                        ? JSON.parse(autoDeployment.metadata) 
                        : autoDeployment.metadata;
                        
                      if (metadata.keyName && typeof metadata.keyName === 'string') {
                        keyName = metadata.keyName;
                        console.log(`[PipelineRunner] Found key name in deployment metadata: ${keyName}`);
                      }
                    } catch (metadataError) {
                      console.error(`[PipelineRunner] Error parsing deployment metadata: ${metadataError.message}`);
                    }
                  }
                  
                  // IMPORTANT: Check if we have SSH key information in the deployment's config
                  // Try to locate the SSH key file that was created during deployment
                  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
                  const sshDir = path.join(homeDir, '.ssh');
                  
                  // First try to locate the key by name if we have it from metadata
                  if (keyName && keyName.startsWith('lightci-')) {
                    try {
                      const keyPath = path.join(sshDir, `${keyName}.pem`);
                      const backupPath = path.join(process.cwd(), `${keyName}.pem`);
                      
                      if (fs.existsSync(keyPath)) {
                        const keyContent = fs.readFileSync(keyPath, 'utf8');
                        deployedInstanceConfig.ec2SshKey = keyContent;
                        deployedInstanceConfig.ec2SshKeyEncoded = Buffer.from(keyContent).toString('base64');
                        console.log(`[PipelineRunner] Using SSH key from ${keyPath} found via metadata`);
                      } else if (fs.existsSync(backupPath)) {
                        const keyContent = fs.readFileSync(backupPath, 'utf8');
                        deployedInstanceConfig.ec2SshKey = keyContent;
                        deployedInstanceConfig.ec2SshKeyEncoded = Buffer.from(keyContent).toString('base64');
                        console.log(`[PipelineRunner] Using SSH key from ${backupPath} found via metadata`);
                      } else {
                        console.log(`[PipelineRunner] Key file ${keyName}.pem not found, will try pattern matching`);
                      }
                    } catch (keyError) {
                      console.error(`[PipelineRunner] Error loading key file by name: ${keyError.message}`);
                    }
                  }
                  
                  // Fall back to pattern matching if we still don't have a key
                  if (!deployedInstanceConfig.ec2SshKey) {
                    // Find recent SSH key files matching LightCI pattern
                    let keyFiles: string[] = [];
                    try {
                      if (fs.existsSync(sshDir)) {
                        const sshFiles = fs.readdirSync(sshDir)
                          .filter(file => file.startsWith('lightci-') && file.endsWith('.pem'))
                          .map(file => path.join(sshDir, file));
                        
                        // Sort by most recent
                        keyFiles = sshFiles
                          .filter(file => fs.existsSync(file))
                          .sort((a, b) => {
                            const statA = fs.statSync(a);
                            const statB = fs.statSync(b);
                            return statB.mtimeMs - statA.mtimeMs;
                          });
                      }
                      
                      if (keyFiles.length > 0) {
                        const mostRecentKeyFile = keyFiles[0];
                        console.log(`[PipelineRunner] Found recent SSH key file: ${mostRecentKeyFile}`);
                        
                        try {
                          // Read the key content
                          const keyContent = fs.readFileSync(mostRecentKeyFile, 'utf8');
                          // Update the deployment config with the key
                          deployedInstanceConfig.ec2SshKey = keyContent;
                          deployedInstanceConfig.ec2SshKeyEncoded = Buffer.from(keyContent).toString('base64');
                          console.log(`[PipelineRunner] Added SSH key from ${mostRecentKeyFile} to deployment config`);
                        } catch (keyReadError) {
                          console.error(`[PipelineRunner] Error reading SSH key file: ${keyReadError.message}`);
                        }
                      } else {
                        console.log(`[PipelineRunner] No recent SSH key files found in ${sshDir}`);
                      }
                    } catch (keySearchError) {
                      console.error(`[PipelineRunner] Error searching for SSH key files: ${keySearchError.message}`);
                    }
                  }
                }
              
                if (!deployedInstanceConfig) {
                  throw new Error('No deployment configuration available for remote execution');
                }
                
                console.log(`[PipelineRunner] Executing command on deployed instance: ${deployedInstanceConfig.publicDns}`);
                result = await this.executeOnDeployedInstance(
                  deployedInstanceConfig,
                  [command],
                  (msg) => {
                    console.log(`[SSH] ${msg}`);
                  }
                );
              } else {
                // Execute locally
                result = await this.executeCommand(command, workspacePath, step.environment || {});
              }

              // Update step status to completed
              stepResult.status = 'completed';
              stepResult.endTime = new Date();
              stepResult.output = result.output;

              await this.prismaClient.pipelineRun.update({
                where: { id: runId },
                data: {
                  stepResults: JSON.stringify(stepResults)
                }
              });

              console.log(`[PipelineRunner] Step ${step.name} completed successfully:`, {
                runId,
                stepId: step.id,
                output: result.output?.substring(0, 100) + '...'
              });
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

              throw error;
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
        // Distribution and build outputs
        '**/dist/**',           // Distribution files
        '**/build/**',          // Build output
        'build/**',             // React build output (root level)
        'build/static/**',      // React static assets
        'dist/**',              // Root level dist directory
        'out/**',               // Next.js static export
        '.next/**',             // Next.js build directory
        '.output/**',           // Nuxt.js build directory
        
        // Common static files
        '**/static/**',         // Static assets
        '**/assets/**',         // Asset files
        '**/public/**',         // Public assets directory
        
        // Source code files
        '**/src/**',            // Source code files
        'src/**',               // Root level source code
        '**/lib/**',            // Library code
        '**/components/**',     // Component directories
        '**/pages/**',          // Pages directories (Next.js etc)
        '**/layouts/**',        // Layout components
        '**/styles/**',         // Style files
        
        // Configuration files
        '**/package.json',      // Package configuration in any directory
        './package.json',       // Root package.json
        'package.json',         // Alternative root package.json pattern
        'package-lock.json',    // Lock file for exact dependency versions
        'yarn.lock',            // Yarn lock file
        'pnpm-lock.yaml',       // PNPM lock file
        '**/.env*',             // Environment configuration files
        '**/tsconfig.json',     // TypeScript configuration
        '**/vite.config.*',     // Vite configuration
        '**/webpack.config.*',  // Webpack configuration
        '**/next.config.*',     // Next.js configuration
        '**/nuxt.config.*',     // Nuxt.js configuration
        '**/svelte.config.*',   // Svelte configuration
        '**/angular.json',      // Angular configuration
        
        // Scripts and binaries
        '**/scripts/**',        // Script directories
        '**/*.sh',              // Shell scripts
        '**/bin/**',            // Binary/executable scripts
        '**/node_modules/.bin/**', // Executable scripts in node_modules
        
        // Docker related
        '**/docker-compose*',   // Docker compose files
        '**/Dockerfile*',       // Dockerfile configurations
        
        // Backend specific
        '**/api/**',            // API directories
        '**/routes/**',         // Route definitions
        '**/controllers/**',    // Controller files
        '**/middlewares/**',    // Middleware files
        '**/models/**',         // Database models
        '**/migrations/**',     // Database migrations
        
        // Monorepo specific
        '**/apps/**/*.js',      // JavaScript files in apps (monorepo)
        '**/apps/**/*.ts',      // TypeScript files in apps (monorepo)
        '**/apps/**/*.jsx',     // React JSX files in apps (monorepo)
        '**/apps/**/*.tsx',     // React TSX files in apps (monorepo)
        '**/packages/**/*.js',  // JavaScript files in packages (monorepo)
        '**/packages/**/*.ts',  // TypeScript files in packages (monorepo)
        
        // Common frontend directories
        'frontend/package.json',
        'frontend/build/**/*',
        'frontend/dist/**/*',
        'frontend/src/**/*',
        'frontend/public/**/*',
        'frontend/.next/**/*',
        'client/package.json',
        'client/build/**/*',
        'client/dist/**/*',
        'client/src/**/*',
        'client/public/**/*',
        'web/package.json',
        'web/build/**/*',
        'web/dist/**/*',
        'web/src/**/*',
        'web/public/**/*',
        
        // Common backend directories
        'backend/package.json',
        'backend/dist/**/*',
        'backend/src/**/*',
        'server/package.json',
        'server/dist/**/*',
        'server/src/**/*',
        'api/package.json',
        'api/dist/**/*',
        'api/src/**/*'
      ];

      // Get configured patterns and combine with defaults
      const configuredPatterns = Array.isArray(pipeline.artifactPatterns) 
        ? pipeline.artifactPatterns 
        : (pipeline.artifactConfig?.patterns || []);
      
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
      await fsPromises.rm(runArtifactsDir, { recursive: true, force: true });
      await fsPromises.mkdir(runArtifactsDir, { recursive: true });
      
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
            await fsPromises.mkdir(path.dirname(destPath), { recursive: true });
            
            // Copy file
            await fsPromises.copyFile(sourcePath, destPath);
            
            // Get file size
            const stats = await fsPromises.stat(sourcePath);
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
      
      // Create a usage record using Prisma's proper methods instead of raw SQL
      await this.prismaClient.usageRecord.create({
        data: {
          id: crypto.randomUUID(),
          usage_type: 'artifact_storage',
          quantity: sizeInMB,
          storage_change: totalSize,
          pipeline_run_id: runId,
          project_id: pipelineWithProject.project?.id,
          user_id: pipelineWithProject.createdById,
          metadata: {
            action: "created",
            artifact_count: artifactsCount,
            storage_type: pipelineWithProject.artifactStorageType
          }
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

  /**
   * Execute a command on the deployed instance via SSH
   */
  private async executeOnDeployedInstance(
    config: DeploymentConfig,
    commands: string[],
    logCallback: (message: string) => void
  ): Promise<{ output: string; error?: string }> {
    // Create temp directory with fs/promises
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'lightci-deploy-'));
    const sshKeyPath = path.join(tmpDir, 'ssh_key.pem');
    
    console.log(`[PipelineRunner] Created temporary directory: ${tmpDir}`);
    console.log(`[PipelineRunner] Will write SSH key to: ${sshKeyPath}`);
    
    // Changed to await the processSshKey call
    if (!await this.processSshKey(config, sshKeyPath)) {
      const errorMsg = 'Failed to process SSH key';
      logCallback(`[ERROR] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    // Use publicDns from the config
    const host = config.publicDns;
    if (!host) {
      const errorMsg = 'No host specified for SSH connection (publicDns missing)';
      logCallback(`[ERROR] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    console.log(`[PipelineRunner] Connecting to EC2 instance via SSH: ${host}`);
    logCallback(`Connecting to instance: ${host}`);
    
    // Read the key directly instead of relying on path
    let privateKeyContent;
    try {
      privateKeyContent = fs.readFileSync(sshKeyPath, 'utf8');
    } catch (readError) {
      const errorMsg = `Failed to read SSH key: ${readError.message}`;
      logCallback(`[ERROR] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    const sshConnectConfig = {
      host,
      username: config.ec2Username || 'ec2-user',
      port: 22,
      privateKey: privateKeyContent, // Use the content directly instead of a path
      readyTimeout: 30000,
      debug: (message: string) => console.log(`[SSH Debug] ${message}`)
    };
    
    try {
      const sshClient = new NodeSSH();
      await sshClient.connect(sshConnectConfig);
      
      let combinedStdout = '';
      let combinedStderr = '';
      let lastStatus = 0;
      
      for (const command of commands) {
        console.log(`[PipelineRunner] Executing command: ${command}`);
        logCallback(`Executing: ${command}`);
        
        const result = await sshClient.execCommand(command, {
          onStdout: (chunk) => {
            const output = chunk.toString();
            console.log(`[SSH stdout] ${output}`);
            logCallback(output);
            combinedStdout += output;
          },
          onStderr: (chunk) => {
            const output = chunk.toString();
            console.error(`[SSH stderr] ${output}`);
            logCallback(`[ERROR] ${output}`);
            combinedStderr += output;
          }
        });
        
        lastStatus = result.code;
        if (lastStatus !== 0) {
          console.error(`[PipelineRunner] Command failed with exit code: ${lastStatus}`);
          logCallback(`Command failed with exit code: ${lastStatus}`);
          break;
        }
      }
      
      sshClient.dispose();
      try {
        await unlink(sshKeyPath);
        await rm(tmpDir, { recursive: true, force: true });
        console.log(`[PipelineRunner] Cleaned up temporary directory: ${tmpDir}`);
      } catch (cleanupError) {
        console.error(`[PipelineRunner] Error cleaning up: ${cleanupError}`);
      }
      
      // Return in the expected format
      return {
        output: combinedStdout + (combinedStderr ? `\nStderr: ${combinedStderr}` : ''),
        error: lastStatus !== 0 ? `Command exited with code ${lastStatus}` : undefined
      };
    } catch (error) {
      console.error(`[PipelineRunner] SSH connection error:`, error);
      logCallback(`[ERROR] SSH connection failed: ${error.message}`);
      
      try {
        await unlink(sshKeyPath);
        await rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // Ignore cleanup errors at this point
      }
      
      return {
        output: '',
        error: error instanceof Error ? error.message : 'Unknown SSH connection error'
      };
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

  // Helper method to build source command that handles subdirectory paths in GitHub URLs
  private buildSourceCommand(repoUrl: string, branch: string): string {
    // Check if the URL contains a GitHub tree path
    const treePathMatch = repoUrl.match(/\/tree\/[^\/]+\/(.+)$/);
    
    if (treePathMatch) {
      // Extract the base repo URL and subdirectory
      const baseRepoUrl = repoUrl.replace(/\/tree\/[^\/]+\/.+$/, '');
      const subDir = treePathMatch[1];
      
      console.log(`[PipelineRunner] Detected subdirectory in repository URL: ${subDir}`);
      console.log(`[PipelineRunner] Will clone from base URL: ${baseRepoUrl}`);
      
      // Build command to clone the repo, checkout the branch, and ensure the subdirectory exists
      return `git clone ${baseRepoUrl} . && git checkout ${branch} && if [ -d "${subDir}" ]; then echo "Subdirectory ${subDir} exists"; else echo "Warning: Subdirectory ${subDir} not found"; fi`;
    }
    
    // Standard repo URL, just clone and checkout
    return `git clone ${repoUrl} . && git checkout ${branch}`;
  }

  /**
   * Process, validate and save an SSH key to a file
   * Handles base64 encoded keys and normalizes line endings
   */
  private async processSshKey(config: DeploymentConfig, keyPath: string): Promise<boolean> {
    try {
      console.log('[PipelineRunner] Processing SSH key');
      console.log(`[PipelineRunner] Key path: ${keyPath}`);
      
      // Try to get the key from both possible sources
      const sshKey = config.ec2SshKey || '';
      const encodedKey = config.ec2SshKeyEncoded || '';
      
      console.log(`[PipelineRunner] Regular key length: ${sshKey.length}, Encoded key length: ${encodedKey.length}`);
      
      let finalKey = '';
      let source = '';
      
      // First try the encoded key if present
      if (encodedKey.length > 0) {
        try {
          const decodedKey = Buffer.from(encodedKey, 'base64').toString('utf-8');
          console.log(`[PipelineRunner] Successfully decoded Base64 key (${decodedKey.length} chars)`);
          
          // Verify it looks like a PEM key (has BEGIN and END markers)
          if (decodedKey.includes('-----BEGIN') && decodedKey.includes('-----END')) {
            finalKey = decodedKey;
            source = 'decoded';
            console.log(`[PipelineRunner] Using decoded key`);
          } else {
            console.log(`[PipelineRunner] Decoded key doesn't look like valid PEM format`);
          }
        } catch (decodeError) {
          console.log(`[PipelineRunner] Error decoding Base64 key: ${decodeError.message}`);
        }
      }
      
      // Fall back to regular key if decoded key didn't work
      if (!finalKey && sshKey.length > 0) {
        finalKey = sshKey;
        source = 'regular';
        console.log(`[PipelineRunner] Using regular SSH key`);
      }
      
      // NEW: Look for recent keys in standard locations if we don't have a key yet
      if (!finalKey) {
        console.log(`[PipelineRunner] No key in config, searching for recently created keys`);
        
        // Look for keys that match lightci-*.pem pattern
        const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
        const sshDir = path.join(homeDir, '.ssh');
        
        // Find all key files in ~/.ssh/ and current directory
        let keyFiles: string[] = [];
        
        try {
          // Look in ~/.ssh
          if (fs.existsSync(sshDir)) {
            const sshFiles = fs.readdirSync(sshDir)
              .filter(file => file.startsWith('lightci-') && file.endsWith('.pem'))
              .map(file => path.join(sshDir, file));
            keyFiles.push(...sshFiles);
          }
          
          // Look in current directory
          const currentDirFiles = fs.readdirSync(process.cwd())
            .filter(file => file.startsWith('lightci-') && file.endsWith('.pem'))
            .map(file => path.join(process.cwd(), file));
          keyFiles.push(...currentDirFiles);
          
          // Sort by most recently modified
          keyFiles = keyFiles
            .filter(file => fs.existsSync(file))
            .sort((a, b) => {
              const statA = fs.statSync(a);
              const statB = fs.statSync(b);
              return statB.mtimeMs - statA.mtimeMs; // Sort descending by modification time
            });
            
            console.log(`[PipelineRunner] Found ${keyFiles.length} potential key files`);
            
            // Try each key from most recent to oldest
            for (const keyFile of keyFiles) {
              try {
                console.log(`[PipelineRunner] Trying key file: ${keyFile}`);
                const keyContent = fs.readFileSync(keyFile, 'utf8');
                
                // Basic validation
                if (keyContent.includes('-----BEGIN') && keyContent.includes('-----END')) {
                  finalKey = keyContent;
                  source = `file:${keyFile}`;
                  console.log(`[PipelineRunner] Found valid SSH key in ${keyFile}`);
                  break;
                }
              } catch (readError) {
                console.log(`[PipelineRunner] Error reading key file ${keyFile}: ${readError.message}`);
              }
            }
        } catch (searchError) {
          console.log(`[PipelineRunner] Error searching for key files: ${searchError.message}`);
        }
      }
      
      if (!finalKey) {
        console.log(`[PipelineRunner] No valid SSH key found in configuration or file system`);
        console.log(`[PipelineRunner] Please ensure a valid SSH key is available for deployment`);
        
        // NEW: Provide detailed error for debugging
        if (config.instanceId) {
          console.log(`[PipelineRunner] Instance ID: ${config.instanceId}`);
        }
        if (config.publicDns) {
          console.log(`[PipelineRunner] Instance DNS: ${config.publicDns}`);
        }
        
        return false;
      }

      // Force the key to have proper RSA format - SSH requires specific formatting
      if (finalKey.includes('-----BEGIN') && finalKey.includes('-----END')) {
        // Extract the headers and content for proper reformatting
        const beginMatch = finalKey.match(/(-----BEGIN [^-]+ -----)/);
        const endMatch = finalKey.match(/(-----END [^-]+ -----)/);

        if (beginMatch && endMatch) {
          const beginHeader = beginMatch[1];
          const endHeader = endMatch[1];
          
          // Extract the content between headers, removing all whitespace
          let content = finalKey.substring(
            finalKey.indexOf(beginHeader) + beginHeader.length,
            finalKey.indexOf(endHeader)
          ).replace(/\s+/g, '');
          
          // Rebuild key with proper formatting (64 char lines)
          const contentLines = [];
          for (let i = 0; i < content.length; i += 64) {
            contentLines.push(content.substring(i, i + 64));
          }
          
          finalKey = [
            beginHeader,
            ...contentLines,
            endHeader
          ].join('\n');
          
          console.log(`[PipelineRunner] Reformed key to standard format with ${contentLines.length} lines`);
        }
      }

      // Log safely truncated key preview for debugging
      if (finalKey.length > 20) {
        console.log(`[PipelineRunner] Key preview: ${finalKey.substring(0, 10)}...${finalKey.substring(finalKey.length - 10)}`);
      }
      
      // Check if the key has proper PEM format
      const begins = finalKey.includes('-----BEGIN');
      const ends = finalKey.includes('-----END');
      
      // If we don't have proper PEM format, try to fix it
      if (!begins || !ends) {
        console.log(`[PipelineRunner] Key is missing PEM markers: BEGIN=${begins}, END=${ends}`);
        return false;
      }
      
      // Generate a standardized key format with proper line breaks
      // Split by newlines, filter empty lines, join with Unix line endings
      const keyLines = finalKey.split(/\r?\n/).filter(line => line.trim() !== '');
      
      // Check if we have enough lines to form a valid key
      if (keyLines.length < 3) {
        console.log(`[PipelineRunner] Not enough lines in key: ${keyLines.length}`);
        
        // If we have a single long line, try to reformat it
        if (keyLines.length === 1 && keyLines[0].length > 100) {
          const line = keyLines[0];
          const beginMatch = line.match(/(-----BEGIN [^-]+ -----)/);
          const endMatch = line.match(/(-----END [^-]+ -----)/);
          
          if (beginMatch && endMatch) {
            const beginHeader = beginMatch[1];
            const endHeader = endMatch[1];
            const contentBetween = line.substring(
              line.indexOf(beginHeader) + beginHeader.length,
              line.indexOf(endHeader)
            ).trim();
            
            // Reformat to standard PEM structure with 64-char lines
            const contentLines = [];
            for (let i = 0; i < contentBetween.length; i += 64) {
              contentLines.push(contentBetween.substring(i, i + 64));
            }
            
            finalKey = [
              beginHeader,
              ...contentLines,
              endHeader
            ].join('\n');
            
            console.log(`[PipelineRunner] Reformatted single-line key to ${contentLines.length + 2} lines`);
          }
        }
      } else {
        // Rebuild the key with proper line endings
        finalKey = keyLines.join('\n');
        console.log(`[PipelineRunner] Normalized key line endings (${keyLines.length} lines)`);
      }
      
      // Add final newline
      if (!finalKey.endsWith('\n')) {
        finalKey += '\n';
      }
      
      // Try multiple methods to write the file
      let writeSuccess = false;
      
      try {
        // Make sure the key looks valid - check the beginning of the key
        if (!finalKey.trim().startsWith('-----BEGIN')) {
          console.log(`[PipelineRunner] Key doesn't start with proper BEGIN marker`);
          return false;
        }
        
        // First try synchronous write - most reliable
        console.log(`[PipelineRunner] Writing SSH key to ${keyPath} (synchronous)`);
        fs.writeFileSync(keyPath, finalKey, { mode: 0o600 });
        writeSuccess = true;
      } catch (syncWriteError) {
        console.log(`[PipelineRunner] Error in sync write: ${syncWriteError.message}`);
        
        // Fallback to async write
        try {
          console.log(`[PipelineRunner] Trying async write instead`);
          await fsPromises.writeFile(keyPath, finalKey, { mode: 0o600 });
          writeSuccess = true;
        } catch (asyncWriteError) {
          console.log(`[PipelineRunner] Error in async write: ${asyncWriteError.message}`);
        }
      }
      
      if (!writeSuccess) {
        console.log(`[PipelineRunner] Failed to write SSH key file`);
        return false;
      }
      
      // Ensure the permissions are set correctly (sometimes mode in writeFile doesn't work)
      try {
        fs.chmodSync(keyPath, 0o600);
        console.log(`[PipelineRunner] Set 0600 permissions on key file`);
      } catch (chmodError) {
        console.log(`[PipelineRunner] Error setting permissions: ${chmodError.message}`);
      }
      
      // Verify the file exists
      if (!existsSync(keyPath)) {
        console.log(`[PipelineRunner] Key file doesn't exist after writing`);
        return false;
      }
      
      // Check file size
      try {
        const stats = statSync(keyPath);
        console.log(`[PipelineRunner] Key file size: ${stats.size} bytes`);
        
        if (stats.size < 100) {
          console.log(`[PipelineRunner] Warning: Key file is suspiciously small`);
        }
      } catch (statError) {
        console.log(`[PipelineRunner] Error checking file stats: ${statError.message}`);
      }
      
      // Read back the file to verify contents
      try {
        const keyContent = fs.readFileSync(keyPath, 'utf8');
        const keyContentLines = keyContent.split('\n').filter(line => line.trim() !== '');
        
        console.log(`[PipelineRunner] Read back key file: ${keyContent.length} chars, ${keyContentLines.length} lines`);
        
        if (keyContentLines.length < 3) {
          console.log(`[PipelineRunner] Warning: Key file has too few lines (${keyContentLines.length})`);
        }
        
        // Check first and last line
        const firstLine = keyContentLines[0] || '';
        const lastLine = keyContentLines[keyContentLines.length - 1] || '';
        
        console.log(`[PipelineRunner] First line: ${firstLine}`);
        console.log(`[PipelineRunner] Last line: ${lastLine}`);
        
        if (!firstLine.includes('BEGIN') || !lastLine.includes('END')) {
          console.log(`[PipelineRunner] Warning: Key file is missing proper BEGIN/END markers`);
        }

        // Add direct debug using OpenSSH command to check key format
        try {
          console.log('[PipelineRunner] Directly testing key with OpenSSH...');
          const sshKeygenCheck = execSync(`ssh-keygen -l -f "${keyPath}"`, { stdio: 'pipe', encoding: 'utf8' });
          console.log(`[PipelineRunner] Key appears valid according to ssh-keygen: ${sshKeygenCheck.trim()}`);
        } catch (sshKeygenError) {
          console.log(`[PipelineRunner] ssh-keygen could not validate key: ${sshKeygenError.message}`);
          
          // Show the actual file content for debugging
          console.log('[PipelineRunner] Key file content (first 100 chars):');
          console.log(keyContent.substring(0, 100) + '...');
          
          // Try validating the key with OpenSSL
          try {
            execSync(`openssl rsa -in "${keyPath}" -check -noout`, { stdio: 'pipe' });
            console.log('[PipelineRunner] OpenSSL reports key is valid');
          } catch (opensslError) {
            console.log(`[PipelineRunner] OpenSSL validation failed: ${opensslError.message}`);
            
            // Try to repair the key if possible
            try {
              // Create a backup of the original key
              fs.copyFileSync(keyPath, `${keyPath}.bak`);
              console.log(`[PipelineRunner] Created backup of key file at ${keyPath}.bak`);
              
              // Try to directly generate a new key file with original key content
              const tempKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-key-'));
              const tempKeyPath = path.join(tempKeyDir, 'key.pem');
              
              // Write the key with explicit headers to ensure format
              const keyContent = [
                "-----BEGIN RSA PRIVATE KEY-----",
                ...finalKey.replace(/^-----(BEGIN|END)[^-]+-----/gm, '').split(/\s+/).filter(Boolean),
                "-----END RSA PRIVATE KEY-----"
              ].join('\n');
              
              fs.writeFileSync(tempKeyPath, keyContent, { mode: 0o600 });
              console.log(`[PipelineRunner] Attempted to repair key in ${tempKeyPath}`);
              
              // Test if the repaired key works
              try {
                execSync(`ssh-keygen -l -f "${tempKeyPath}"`, { stdio: 'pipe' });
                console.log('[PipelineRunner] Repaired key appears valid, using it instead');
                
                // Replace the original key with the repaired one
                fs.copyFileSync(tempKeyPath, keyPath);
              } catch (repairError) {
                console.log(`[PipelineRunner] Repair attempt failed: ${repairError.message}`);
              } finally {
                // Clean up temp files
                fs.rmSync(tempKeyDir, { recursive: true, force: true });
              }
            } catch (repairAttemptError) {
              console.log(`[PipelineRunner] Error during repair attempt: ${repairAttemptError.message}`);
            }
          }
        }
      } catch (readError) {
        console.log(`[PipelineRunner] Error reading back key file: ${readError.message}`);
      }
      
      // As a final check, verify the key with ssh-keygen
      try {
        // Use -l to list the key fingerprint (validates the key format)
        const keyInfo = execSync(`ssh-keygen -l -f "${keyPath}"`, { encoding: 'utf8' });
        console.log(`[PipelineRunner] Key validated with ssh-keygen: ${keyInfo.trim()}`);
      } catch (keygenError) {
        console.log(`[PipelineRunner] Warning: ssh-keygen couldn't validate key: ${keygenError.message || 'unknown error'}`);
        
        // Try again with different parameters
        try {
          const keyTest = execSync(`ssh-keygen -y -f "${keyPath}"`, { encoding: 'utf8' });
          if (keyTest.includes('ssh-rsa')) {
            console.log(`[PipelineRunner] Key validated with ssh-keygen -y`);
          } else {
            console.log(`[PipelineRunner] Key validation returned unexpected output: ${keyTest.substring(0, 50)}...`);
          }
        } catch (alternateSshKeygenError) {
          console.log(`[PipelineRunner] Key failed second validation: ${alternateSshKeygenError.message || 'unknown error'}`);
          
          // If validation fails, this is likely a corrupted key
          console.log(`[PipelineRunner] This may indicate a corrupted SSH key file`);
          return false; // Changed to return false on validation failure
        }
      }
      
      console.log(`[PipelineRunner] SSH key processing completed successfully (from ${source})`);
      return true;
    } catch (error) {
      console.log(`[PipelineRunner] Error processing SSH key: ${error.message}`);
      return false;
    }
  }

  /**
   * Retrieve SSH key information from a deployment or metadata
   */
  private async retrieveSshKeyInfo(
    pipelineId: string,
    deploymentConfig: any,
    deployment?: any
  ): Promise<{ keyName: string, keyPath?: string, encodedKey?: string }> {
    try {
      let keyName = '';
      let keyPath: string | undefined;
      let encodedKey: string | undefined;
      
      // Check if we have a deployment with sshKeyId
      if (deployment?.sshKeyId) {
        try {
          const key = await this.sshKeyService.getKeyById(deployment.sshKeyId);
          if (key) {
            console.log(`[PipelineRunnerService] Using SSH key from deployment: ${key.keyPairName}`);
            keyName = key.keyPairName;
            
            // Use the content from the key for encoded content
            if (key.content) {
              encodedKey = Buffer.from(key.content).toString('base64');
            }
            
            // Write the key to a file
            keyPath = await this.sshKeyService.writeKeyToFile(key.keyPairName, key.content);
            return { keyName, keyPath, encodedKey };
          }
        } catch (error) {
          console.log(`[PipelineRunnerService] Error retrieving key by ID: ${error.message}`);
        }
      }
      
      // Check if we have a deployment with key metadata
      if (deployment?.metadata && typeof deployment.metadata === 'object') {
        const metadata = deployment.metadata as any;
        if (metadata.keyName) {
          keyName = metadata.keyName;
          console.log(`[PipelineRunnerService] Found key name in deployment metadata: ${keyName}`);
          
          // Try to find the key in our database
          const key = await this.sshKeyService.getKeyByPairName(keyName);
          if (key) {
            console.log(`[PipelineRunnerService] Found key in database: ${keyName}`);
            encodedKey = key.encodedContent;
            keyPath = await this.sshKeyService.writeKeyToFile(keyName, key.content);
            return { keyName, keyPath, encodedKey };
          }
          
          // Try to find the key in the file system as fallback
          if (metadata.keyPath) {
            keyPath = metadata.keyPath;
            if (fs.existsSync(keyPath)) {
              console.log(`[PipelineRunnerService] Found key at path: ${keyPath}`);
              
              // Store the key in our database for future use
              try {
                const keyContent = fs.readFileSync(keyPath, 'utf8');
                const encodedContent = Buffer.from(keyContent).toString('base64');
                
                await this.sshKeyService.createKey({
                  name: keyName,
                  content: keyContent,
                  keyPairName: keyName
                });
                console.log(`[PipelineRunnerService] Added key ${keyName} to database for future use`);
                
                encodedKey = encodedContent;
              } catch (storeError) {
                console.log(`[PipelineRunnerService] Could not store key in database: ${storeError.message}`);
                // Continue anyway, this is just an optimization
              }
              
              return { keyName, keyPath, encodedKey };
            } else {
              console.log(`[PipelineRunnerService] Key path not found: ${keyPath}`);
            }
          }
        }
      }
      
      // Check if we have a key name in the deployment config
      if (deploymentConfig?.keyName) {
        keyName = deploymentConfig.keyName;
        console.log(`[PipelineRunnerService] Using key name from deployment config: ${keyName}`);
        
        // Try to find the key in our database
        const key = await this.sshKeyService.getKeyByPairName(keyName);
        if (key) {
          console.log(`[PipelineRunnerService] Found key in database: ${keyName}`);
          encodedKey = key.encodedContent;
          keyPath = await this.sshKeyService.writeKeyToFile(keyName, key.content);
          return { keyName, keyPath, encodedKey };
        }
        
        // Fall back to the original file system lookup
        const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
        const sshDir = path.join(homeDir, '.ssh');
        const possibleKeyPaths = [
          path.join(sshDir, keyName),
          path.join(sshDir, `${keyName}.pem`),
          path.join(sshDir, 'id_rsa'),
          path.join(process.cwd(), `${keyName}.pem`),
          `/etc/ssh/keys/${keyName}.pem`
        ];
        
        for (const kPath of possibleKeyPaths) {
          try {
            if (fs.existsSync(kPath)) {
              keyPath = kPath;
              console.log(`[PipelineRunnerService] Found key at: ${keyPath}`);
              
              // Store the key in our database for future use
              try {
                const keyContent = fs.readFileSync(kPath, 'utf8');
                const encodedContent = Buffer.from(keyContent).toString('base64');
                
                await this.sshKeyService.createKey({
                  name: keyName,
                  content: keyContent,
                  keyPairName: keyName
                });
                console.log(`[PipelineRunnerService] Added key ${keyName} to database for future use`);
                
                encodedKey = encodedContent;
              } catch (storeError) {
                console.log(`[PipelineRunnerService] Could not store key in database: ${storeError.message}`);
                // Continue anyway, this is just an optimization
              }
              
              break;
            }
          } catch (e) {
            // File doesn't exist or can't be accessed, continue checking
          }
        }
      }
      
      if (!keyName) {
        console.log(`[PipelineRunnerService] No SSH key information found for pipeline ${pipelineId}`);
      }
      
      return { keyName, keyPath, encodedKey };
    } catch (error) {
      console.error(`[PipelineRunnerService] Error retrieving SSH key info: ${error.message}`);
      return { keyName: '' };
    }
  }
}