import { Pipeline } from '../models/Pipeline.js';
import { EngineService } from './engine.service.js';
import { PrismaClient, Prisma } from '@prisma/client';
import { Build } from '../models/Build.js';
import { prisma } from '../db.js';
import { EventEmitter } from 'events';
import { EC2Client, DescribeInstancesCommand, CreateKeyPairCommand, DeleteKeyPairCommand, DescribeInstanceStatusCommand } from '@aws-sdk/client-ec2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import { InstanceProvisionerService, InstanceConfig } from './instance-provisioner.service.js';

const execAsync = promisify(exec);

type JsonValue = string | number | boolean | { [key: string]: JsonValue } | JsonValue[];

type PipelineStatus = 'pending' | 'running' | 'completed' | 'failed';

interface PipelineStep {
  name: string;
  command: string;
  [key: string]: JsonValue;
}

interface PipelineTriggers {
  events?: ("push" | "pull_request")[];
  branches?: string[];
}

interface WebhookConfig {
  github?: {
    id: number;
    url: string;
  };
}

interface ExtendedPipeline extends Omit<Pipeline, 'steps' | 'triggers' | 'schedule' | 'webhookConfig' | 'artifactPatterns' | 'artifactStorageConfig'> {
  workspaceId: string;
  deploymentConfig: Record<string, JsonValue>;
  status: PipelineStatus;
  steps: PipelineStep[];
  triggers: PipelineTriggers;
  schedule: Record<string, any>;
  webhookConfig: WebhookConfig;
  artifactPatterns: string[];
  artifactStorageConfig: Record<string, any>;
  description?: string;
  deploymentPlatform?: string;
  deploymentMode?: 'automatic' | 'manual';
}

// Create a type for PipelineRun based on the Prisma schema
type PipelineRun = {
  id: string;
  pipelineId: string;
  status: string;
  branch: string;
  commit?: string | null;
  startedAt: Date;
  completedAt?: Date | null;
  stepResults: Record<string, JsonValue>;
  logs: string[];
  error?: string | null;
  artifactsCollected: boolean;
  artifactsCount?: number | null;
  artifactsExpireAt?: Date | null;
  artifactsPath?: string | null;
  artifactsSize?: number | null;
  pipeline: ExtendedPipeline;
  createdById: string;
};

// Create an event emitter for deployment events
export const deploymentEvents = new EventEmitter();

export interface DeploymentResult {
  success: boolean;
  message: string;
  details?: Record<string, any>;
  logs: string[];
}

export type DeploymentPlatform = 'aws' | 'aws_ec2' | 'aws_ecs' | 'gcp' | 'azure' | 'kubernetes' | 'custom';

export interface BlueGreenConfig {
  productionPort: number;
  stagingPort: number;
  healthCheckPath: string;
  healthCheckTimeout: number;
  rollbackOnFailure: boolean;
}

export interface DeploymentConfig {
  platform: string;
  config: Record<string, any>;
  mode?: 'automatic' | 'manual';
  instanceId?: string;
  region?: string;
  service?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  ec2SshKey?: string;
  ec2Username?: string;
  ec2DeployPath?: string;
  environmentVariables?: Record<string, string>;
  strategy?: 'standard' | 'blue-green';
  blueGreenConfig?: BlueGreenConfig;
  // Additional properties for EC2 deployment
  ec2InstanceId?: string;
  publicDns?: string;
}

export class DeploymentService {
  private engineService: EngineService;
  private instanceProvisioner: InstanceProvisionerService;
  private artifacts_base_dir: string;
  
  constructor(engineService: EngineService) {
    this.engineService = engineService;
    this.artifacts_base_dir = process.env.ARTIFACTS_PATH || '/tmp/lightci/artifacts';
    console.log('[DeploymentService] Initialized with artifacts base directory:', this.artifacts_base_dir);
  }
  
  private async initializeInstanceProvisioner(config: DeploymentConfig) {
    if (!this.instanceProvisioner && config.awsAccessKeyId && config.awsSecretAccessKey) {
      let keyName = config.ec2SshKey || config.config?.keyPairName;
      let privateKey = '';

      // For automatic deployment, create a new key pair
      if (config.mode === 'automatic') {
        const ec2Client = new EC2Client({
          region: config.region || 'us-east-1',
          credentials: {
            accessKeyId: config.awsAccessKeyId,
            secretAccessKey: config.awsSecretAccessKey
          }
        });

        // Generate a unique key pair name
        keyName = `lightci-${crypto.randomBytes(8).toString('hex')}`;
        
        try {
          // Create the key pair in AWS
          const createKeyPairCommand = new CreateKeyPairCommand({
            KeyName: keyName,
            KeyType: 'rsa',
            KeyFormat: 'pem'
          });
          
          const keyPairResponse = await ec2Client.send(createKeyPairCommand);
          privateKey = keyPairResponse.KeyMaterial || '';
          
          // Store the private key in the config for later use
          config.ec2SshKey = privateKey;
          
          console.log(`[DeploymentService] Created new key pair: ${keyName}`);
        } catch (error) {
          console.error('[DeploymentService] Failed to create key pair:', error);
          throw error;
        }
      }

      const instanceConfig: InstanceConfig = {
        region: config.region || 'us-east-1',
        imageId: config.config?.imageId || 'ami-0889a44b331db0194', // Amazon Linux 2 AMI in us-east-1
        keyName: keyName || '',
        securityGroupIds: config.config?.securityGroupIds || [],
        subnetId: config.config?.subnetId || '',
        userData: config.config?.userData
      };

      this.instanceProvisioner = new InstanceProvisionerService(
        prisma,
        instanceConfig,
        config.awsAccessKeyId,
        config.awsSecretAccessKey
      );
    }
  }

  // Add cleanup method for key pairs
  private async cleanupKeyPair(config: DeploymentConfig, keyName: string) {
    if (config.mode === 'automatic' && keyName.startsWith('lightci-')) {
      const ec2Client = new EC2Client({
        region: config.region || 'us-east-1',
        credentials: {
          accessKeyId: config.awsAccessKeyId || '',
          secretAccessKey: config.awsSecretAccessKey || ''
        }
      });

      try {
        const deleteKeyPairCommand = new DeleteKeyPairCommand({
          KeyName: keyName
        });
        await ec2Client.send(deleteKeyPairCommand);
        console.log(`[DeploymentService] Deleted key pair: ${keyName}`);
      } catch (error) {
        console.error(`[DeploymentService] Failed to delete key pair ${keyName}:`, error);
      }
    }
  }

  /**
   * Deploys a successful pipeline run based on the pipeline's deployment configuration
   */
  async deployPipelineRun(
    runId: string,
    config: DeploymentConfig
  ): Promise<{ success: boolean; message?: string; logs?: string[] }> {
    console.log(`[DeploymentService] Starting deployment for pipeline run ${runId}`);
    try {
      // Get the pipeline run
      console.log(`[DeploymentService] Fetching pipeline run ${runId} from database`);
      const dbRun = await prisma.pipelineRun.findUnique({
        where: { id: runId },
        include: { pipeline: true }
      });
      
      if (!dbRun) {
        console.error(`[DeploymentService] Pipeline run ${runId} not found`);
        return {
          success: false,
          message: 'Pipeline run not found',
          logs: ['Pipeline run not found']
        };
      }
      
      // Convert database result to PipelineRun type
      const run: PipelineRun = {
        ...dbRun,
        stepResults: dbRun.stepResults as Record<string, JsonValue>,
        logs: Array.isArray(dbRun.logs) ? (dbRun.logs as string[]) : [],
        createdById: dbRun.pipeline.createdById || 'system',
        pipeline: {
          ...dbRun.pipeline,
          workspaceId: (dbRun as any).workspaceId || '',
          status: (dbRun.pipeline.status || 'pending') as PipelineStatus,
          description: dbRun.pipeline.description || undefined,
          deploymentPlatform: dbRun.pipeline.deploymentPlatform || undefined,
          steps: (Array.isArray(dbRun.pipeline.steps) ? dbRun.pipeline.steps : []) as PipelineStep[],
          triggers: (dbRun.pipeline.triggers || { events: [], branches: [] }) as PipelineTriggers,
          schedule: (dbRun.pipeline.schedule || {}) as Record<string, any>,
          webhookConfig: (dbRun.pipeline.webhookConfig || { github: undefined }) as WebhookConfig,
          artifactPatterns: (Array.isArray(dbRun.pipeline.artifactPatterns) ? dbRun.pipeline.artifactPatterns : []) as string[],
          artifactStorageConfig: (dbRun.pipeline.artifactStorageConfig || {}) as Record<string, any>,
          deploymentConfig: (dbRun.pipeline.deploymentConfig || {}) as Record<string, JsonValue>,
          createdById: dbRun.pipeline.createdById || 'system'
        }
      };
      
      console.log(`[DeploymentService] Found pipeline run ${runId} with status ${run.status}`);
      
      // Check if deployment is enabled for this pipeline
      if (!run.pipeline.deploymentEnabled) {
        console.error(`[DeploymentService] Deployment is not enabled for pipeline ${run.pipelineId}`);
        return {
          success: false,
          message: 'Deployment is not enabled for this pipeline',
          logs: ['Deployment is not enabled for this pipeline']
        };
      }
      
      console.log(`[DeploymentService] Deployment is enabled for pipeline ${run.pipelineId}`);
      
      // Get the deployment platform and config
      const platform = run.pipeline.deploymentPlatform as DeploymentPlatform;
      const deploymentConfig: DeploymentConfig = {
        ...config,
        ...(run.pipeline.deploymentConfig as unknown as Partial<DeploymentConfig>)
      };

      // For automatic deployment, ensure service is set to ec2
      if (deploymentConfig.mode === 'automatic') {
        deploymentConfig.service = 'ec2';
      }
      
      console.log(`[DeploymentService] Deployment platform: ${platform}, config:`, JSON.stringify(deploymentConfig, null, 2));
      
      if (!platform) {
        console.error(`[DeploymentService] No deployment platform configured for pipeline ${run.pipelineId}`);
        return {
          success: false,
          message: 'No deployment platform configured',
          logs: ['No deployment platform configured']
        };
      }
      
      // Convert the run to a build to use existing engine service methods
      console.log(`[DeploymentService] Converting run ${runId} to build`);
      const buildResult = await this.engineService.getBuild(runId);
      if (!buildResult) {
        throw new Error(`Failed to get build for run ${runId}`);
      }
      const build: Build = buildResult;
      
      // Emit event that deployment is starting
      console.log(`[DeploymentService] Emitting deployment:start event for run ${runId}`);
      deploymentEvents.emit('deployment:start', {
        runId,
        pipelineId: run.pipelineId,
        platform
      });
      
      // Perform deployment based on platform
      let result: DeploymentResult;
      
      console.log(`[DeploymentService] Starting deployment for platform ${platform}`);
      
      // Determine the actual deployment platform based on the platform and service
      let effectivePlatform = platform;
      
      // Debug the config to ensure service is properly detected
      console.log(`[DeploymentService] Config type: ${typeof deploymentConfig}, service: ${deploymentConfig.service}`);
      
      // Make sure config is properly parsed if it's a string
      const parsedConfig = typeof deploymentConfig === 'string' ? JSON.parse(deploymentConfig) : deploymentConfig;
      
      if (platform === 'aws' && (parsedConfig.service === 'ec2' || parsedConfig.service === 'ec2')) {
        effectivePlatform = 'aws_ec2';
        console.log(`[DeploymentService] Platform is 'aws' with service 'ec2', treating as '${effectivePlatform}'`);
      }
      
      // Initialize instance provisioner if needed
      await this.initializeInstanceProvisioner(config);
      
      switch (effectivePlatform) {
        case 'aws_ec2':
          console.log(`[DeploymentService] Deploying to AWS EC2`);
          if (config.mode === 'automatic' && this.instanceProvisioner) {
            try {
              // Define the type for auto_deployments table
              type AutoDeployment = {
                id: string;
                instance_id: string;
                status: string;
                pipeline_id: string | null;
              };

              // Find existing active deployments for this pipeline
              const existingDeployments = await prisma.$queryRaw<AutoDeployment[]>`
                SELECT * FROM auto_deployments
                WHERE pipeline_id = ${run.pipelineId}
                AND status = 'active'
                ORDER BY created_at DESC
                LIMIT 1
              `;

              let instanceId: string;
              let publicDns: string;

              // Try to reuse existing instance if available
              if (existingDeployments.length > 0) {
                const deployment = existingDeployments[0];
                console.log(`[DeploymentService] Found existing deployment: ${deployment.id}`);

                // Check if instance is healthy
                const isHealthy = await this.checkInstanceHealth(deployment.instance_id, config);

                if (isHealthy) {
                  console.log(`[DeploymentService] Reusing existing healthy instance: ${deployment.instance_id}`);
                  instanceId = deployment.instance_id;

                  // Get instance DNS
                  const ec2Client = new EC2Client({
                    region: config.region || 'us-east-1',
                    credentials: {
                      accessKeyId: config.awsAccessKeyId || '',
                      secretAccessKey: config.awsSecretAccessKey || ''
                    }
                  });

                  const describeCommand = new DescribeInstancesCommand({
                    InstanceIds: [instanceId]
                  });
                  
                  const response = await ec2Client.send(describeCommand);
                  const instance = response.Reservations?.[0]?.Instances?.[0];
                  
                  if (!instance?.PublicDnsName) {
                    throw new Error(`Unable to get public DNS for instance ${instanceId}`);
                  }

                  publicDns = instance.PublicDnsName;
                } else {
                  console.log(`[DeploymentService] Existing instance unhealthy, terminating: ${deployment.instance_id}`);
                  // Terminate unhealthy instance
                  await this.instanceProvisioner.terminateInstance(deployment.id);
                  
                  // Provision new instance
                  const result = await this.instanceProvisioner.provisionInstance(run.pipeline.createdById, run.pipelineId);
                  instanceId = result.instanceId;
                  publicDns = result.publicDns;
                }
              } else {
                console.log(`[DeploymentService] No existing deployment found, provisioning new instance`);
                // No existing instance, provision new one
                const result = await this.instanceProvisioner.provisionInstance(run.pipeline.createdById, run.pipelineId);
                instanceId = result.instanceId;
                publicDns = result.publicDns;
              }

              // Update the config with the instance details
              config.instanceId = instanceId;
              config.config = {
                ...config.config,
                ec2InstanceId: instanceId,
                publicDns
              };

              // Also update the deployment config at the root level for backward compatibility
              config.ec2InstanceId = instanceId;
              config.publicDns = publicDns;
            } catch (error) {
              console.error('[DeploymentService] Failed to provision/reuse instance:', error);
              return {
                success: false,
                message: `Failed to provision/reuse EC2 instance: ${error instanceof Error ? error.message : 'Unknown error'}`,
                logs: [`Failed to provision/reuse EC2 instance: ${error instanceof Error ? error.message : 'Unknown error'}`]
              };
            }
          }
          result = await this.deployToAwsEc2(run, config);
          break;
        case 'aws':
          // Handle AWS services
          if (parsedConfig.service === 'ec2') {
            // This case should be handled by the effectivePlatform logic above
            // but keeping as a fallback
            console.log(`[DeploymentService] Deploying to AWS EC2 via 'aws' platform`);
            result = await this.deployToAwsEc2(run, config);
          } else {
            // Handle other AWS services (lambda, ecs, etc.)
            console.error(`[DeploymentService] Deployment to AWS ${parsedConfig.service || 'default'} is not yet implemented`);
            result = {
              success: false,
              message: `Deployment to AWS ${parsedConfig.service || 'default'} is not yet implemented`,
              logs: [`Deployment to AWS ${parsedConfig.service || 'default'} is not yet implemented`]
            };
          }
          break;
        case 'aws_ecs':
        case 'gcp':
        case 'azure':
        case 'kubernetes':
        case 'custom':
          console.error(`[DeploymentService] Deployment to ${effectivePlatform} is not yet implemented`);
          result = {
            success: false,
            message: `Deployment to ${effectivePlatform} is not yet implemented`,
            logs: [`Deployment to ${effectivePlatform} is not yet implemented`]
          };
          break;
        default:
          console.error(`[DeploymentService] Unknown deployment platform: ${effectivePlatform}`);
          result = {
            success: false,
            message: `Unknown deployment platform: ${effectivePlatform}`,
            logs: [`Unknown deployment platform: ${effectivePlatform}`]
          };
      }
      
      // Update the pipeline run with deployment result
      console.log(`[DeploymentService] Updating pipeline run ${runId} with deployment logs`);
      await prisma.pipelineRun.update({
        where: { id: runId },
        data: {
          logs: {
            push: [
              ...(Array.isArray(run.logs) ? run.logs : []), 
              ...result.logs.map(log => `[DEPLOYMENT] ${log}`)
            ]
          }
        }
      });
      
      // Emit event with deployment result
      console.log(`[DeploymentService] Emitting deployment:complete event for run ${runId} with success=${result.success}`);
      deploymentEvents.emit('deployment:complete', {
        runId,
        pipelineId: run.pipelineId,
        platform: effectivePlatform,
        success: result.success,
        message: result.message
      });
      
      if (result.success) {
        console.log(`[DeploymentService] Deployment for run ${runId} completed successfully`);
      } else {
        console.error(`[DeploymentService] Deployment for run ${runId} failed: ${result.message}`);
      }
      
      return result;
    } catch (error) {
      console.error('[DeploymentService] Error deploying pipeline run:', error);
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const result = {
        success: false,
        message: `Deployment failed: ${errorMessage}`,
        logs: [`Deployment error: ${errorMessage}`]
      };
      
      // Emit event for deployment failure
      console.error(`[DeploymentService] Emitting deployment:error event for run ${runId}`);
      deploymentEvents.emit('deployment:error', {
        runId,
        error: errorMessage
      });
      
      return result;
    }
  }
  
  /**
   * Deploy artifacts to an AWS EC2 instance
   */
  private async deployToAwsEc2(
    run: PipelineRun,
    config: DeploymentConfig
  ): Promise<DeploymentResult> {
    const logs: string[] = [];
    const logAndConsole = (message: string) => {
      logs.push(message);
      console.log(`[DeploymentService] ${message}`);
    };

    logAndConsole(`Starting deployment to AWS EC2 instance ${config.config?.ec2InstanceId || config.instanceId}`);
    logAndConsole(`Deployment run ID: ${run.id}`);
    
    try {
      // Create EC2 client with credentials
      logAndConsole('Initializing AWS EC2 client...');
      const ec2Client = new EC2Client({
        region: config.region || 'us-east-1',
        credentials: {
          accessKeyId: config.awsAccessKeyId || '',
          secretAccessKey: config.awsSecretAccessKey || ''
        }
      });
      logAndConsole(`AWS EC2 client initialized for region: ${config.region || 'us-east-1'}`);

      // Get instance details
      const instanceId = config.config?.ec2InstanceId || config.instanceId;
      if (!instanceId) {
        throw new Error('No instance ID provided in configuration');
      }

      logAndConsole(`Fetching EC2 instance details for ${instanceId}...`);
      const describeCommand = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });
      const instanceData = await ec2Client.send(describeCommand);
      
      const instance = instanceData.Reservations?.[0]?.Instances?.[0];
      if (!instance || !instance.PublicDnsName) {
        throw new Error(`Unable to find public DNS for instance ${instanceId}`);
      }
      
      // Get instance public DNS name for SSH
      const publicDnsName = instance.PublicDnsName;
      logAndConsole(`Found EC2 instance public DNS: ${publicDnsName}`);
      
      if (!publicDnsName) {
        logAndConsole('ERROR: EC2 instance does not have a public DNS name');
        return {
          success: false,
          message: 'EC2 instance does not have a public DNS name',
          logs
        };
      }
      
      // Create temporary directory for deployment
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightci-deploy-'));
      const keyPath = path.join(tempDir, 'ssh-key.pem');
      const tarPath = path.join(tempDir, 'deploy.tar.gz');
      
      // Write SSH key to file
      fs.writeFileSync(keyPath, config.ec2SshKey || '', { mode: 0o600 });
      
      const username = config.ec2Username || 'ec2-user';
      const remotePath = config.ec2DeployPath || '/home/ec2-user/app';

      // For blue/green deployment, we need to determine current environment
      if (config.strategy === 'blue-green' && config.blueGreenConfig) {
        logAndConsole('Starting blue/green deployment process...');
        const bg = config.blueGreenConfig;

        // Check which environment is currently active
        const checkActiveEnvCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "sudo lsof -i :${bg.productionPort} || true"`;
        const { stdout: activeEnvOutput } = await this.executeCommand(checkActiveEnvCmd);
        
        // Determine which environment to deploy to
        const isBlueActive = activeEnvOutput.includes(`${remotePath}/blue`);
        const targetEnv = isBlueActive ? 'green' : 'blue';
        const currentEnv = isBlueActive ? 'blue' : 'green';
        logAndConsole(`Current active environment is ${currentEnv}, deploying to ${targetEnv}`);

        // Set up deployment paths
        const targetPath = `${remotePath}/${targetEnv}`;
        const currentPath = `${remotePath}/${currentEnv}`;

        // Create target directory if it doesn't exist
        const mkdirCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "mkdir -p ${targetPath}"`;
        await this.executeCommand(mkdirCmd);
        logAndConsole(`Created target directory: ${targetPath}`);

        // Deploy to target environment
        logAndConsole(`Deploying to ${targetEnv} environment...`);
        
        // Create and upload deployment archive
        logAndConsole('Creating deployment archive...');
        await this.createArchive(run.artifactsPath || '', tarPath);
        
        // Upload and extract files
        const scpCmd = `scp -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ${keyPath} ${tarPath} ${username}@${publicDnsName}:${targetPath}/deploy.tar.gz`;
        await this.executeCommand(scpCmd);
        
        const extractCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "cd ${targetPath} && tar -xzf deploy.tar.gz"`;
        await this.executeCommand(extractCmd);
        
        // Install dependencies in target environment
        logAndConsole('Installing dependencies...');
        const installCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "cd ${targetPath} && npm install"`;
        await this.executeCommand(installCmd);

        // Start application in target environment
        logAndConsole(`Starting application on port ${bg.stagingPort}...`);
        const startCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "cd ${targetPath} && PORT=${bg.stagingPort} pm2 start npm --name 'lightci-${targetEnv}' -- start"`;
        await this.executeCommand(startCmd);

        // Health check
        logAndConsole(`Performing health check on ${bg.healthCheckPath}...`);
        let healthy = false;
        const startTime = Date.now();
        
        while (Date.now() - startTime < bg.healthCheckTimeout * 1000) {
          try {
            const healthCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "curl -s -f http://localhost:${bg.stagingPort}${bg.healthCheckPath}"`;
            await this.executeCommand(healthCmd);
            healthy = true;
            break;
          } catch (error) {
            logAndConsole('Health check failed, retrying...');
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }

        if (!healthy) {
          logAndConsole('Health check failed, initiating rollback...');
          // Stop the new environment
          const stopCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "pm2 delete lightci-${targetEnv} || true"`;
          await this.executeCommand(stopCmd);
          
          if (bg.rollbackOnFailure) {
            throw new Error('Health check failed, rolled back to previous version');
          }
        }

        // Switch traffic
        logAndConsole('Switching traffic to new environment...');
        const switchCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "
          sudo iptables -t nat -D PREROUTING -p tcp --dport ${bg.productionPort} -j REDIRECT --to-port ${isBlueActive ? bg.productionPort : bg.stagingPort} || true
          sudo iptables -t nat -A PREROUTING -p tcp --dport ${bg.productionPort} -j REDIRECT --to-port ${bg.stagingPort}
          pm2 delete lightci-${currentEnv} || true
        "`;
        await this.executeCommand(switchCmd);

        logAndConsole(`Successfully switched traffic to ${targetEnv} environment`);
        return {
          success: true,
          message: `Successfully deployed to ${targetEnv} environment`,
          logs,
          details: {
            environment: targetEnv,
            port: bg.stagingPort,
            healthCheckPath: bg.healthCheckPath
          }
        };
      } else {
        // Standard deployment logic
        // Check if we have artifacts to deploy
        if (!run.artifactsPath) {
          logAndConsole('ERROR: No artifacts to deploy (artifactsPath is empty)');
          return {
            success: false,
            message: 'No artifacts to deploy',
            logs
          };
        }
        
        logAndConsole(`Found artifacts at path: ${run.artifactsPath}`);
        
        // Create a temporary directory for the SSH key
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightci-deploy-'));
        logAndConsole(`Created temporary directory: ${tempDir}`);
        
        const keyPath = path.join(tempDir, 'ssh_key.pem');
        
        try {
          // Write SSH key to file
          if (!config.ec2SshKey) {
            logAndConsole('ERROR: SSH key not provided in configuration');
            return {
              success: false,
              message: 'SSH key not provided in configuration',
              logs
            };
          }
          
          // Clean up the SSH key in case it has extra whitespace or formatting issues
          const sshKey = config.ec2SshKey.trim();
          
          fs.writeFileSync(keyPath, sshKey, { mode: 0o600 });
          logAndConsole('SSH key written and permissions set to 600');
          
          // Create deployment package
          const artifactsPath = run.artifactsPath;
          const tarPath = path.join(tempDir, 'deploy.tar.gz');
          
          // Upload to EC2 instance
          const username = config.ec2Username || 'ec2-user';
          const remotePath = (config.ec2DeployPath || '/home/ec2-user/app').trim();
          
          logAndConsole(`Preparing to deploy to ${username}@${publicDnsName}:${remotePath}`);

          // Clean up the target directory if it exists
          logAndConsole('Cleaning up target directory...');
          const cleanupCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -v -i ${keyPath} ${username}@${publicDnsName} "if [ -d '${remotePath}' ]; then rm -rf ${remotePath}/*; fi"`;
          await this.executeCommand(cleanupCmd);
          logAndConsole('Target directory cleaned');
          
          // Create remote directory if it doesn't exist
          logAndConsole('Creating remote deployment directory...');
          const mkdirCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -v -i ${keyPath} ${username}@${publicDnsName} "mkdir -p ${remotePath}"`;
          await this.executeCommand(mkdirCmd);
          logAndConsole(`Remote directory ${remotePath} created successfully`);
          
          // Install Node.js and npm if not already installed
          logAndConsole('Setting up Node.js environment on remote instance...');
          const setupCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -v -i ${keyPath} ${username}@${publicDnsName} "
            if ! command -v node &> /dev/null; then
              curl -sL https://rpm.nodesource.com/setup_18.x | sudo bash -
              sudo yum install -y nodejs
            fi
            if ! command -v pm2 &> /dev/null; then
              sudo npm install -g pm2@latest
            fi
          "`;
          await this.executeCommand(setupCmd);
          logAndConsole('Node.js and PM2 environment setup completed');
          
          // Upload tar file
          logAndConsole('Creating deployment archive...');
          await this.createArchive(run.artifactsPath, tarPath);
          logAndConsole(`Deployment archive created successfully at ${tarPath}`);
          
          logAndConsole('Uploading deployment archive to remote instance...');
          const scpCmd = `scp -o StrictHostKeyChecking=no -o ConnectTimeout=30 -v -i ${keyPath} ${tarPath} ${username}@${publicDnsName}:${remotePath}/deploy.tar.gz`;
          await this.executeCommand(scpCmd);
          logAndConsole('Deployment archive uploaded successfully');
          
          // Extract tar file on remote instance
          logAndConsole('Extracting deployment archive on remote instance...');
          const extractCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -v -i ${keyPath} ${username}@${publicDnsName} "cd ${remotePath} && tar -xzf deploy.tar.gz"`;
          await this.executeCommand(extractCmd);
          logAndConsole('Deployment archive extracted successfully');
          
          // Install npm dependencies
          logAndConsole('Installing npm dependencies on remote instance...');
          const installCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -v -i ${keyPath} ${username}@${publicDnsName} "cd ${remotePath} && npm install"`;
          await this.executeCommand(installCmd);
          logAndConsole('npm dependencies installed successfully');
          
          // Stop any existing PM2 processes and start the application
          logAndConsole('Starting application with PM2...');
          const startCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -v -i ${keyPath} ${username}@${publicDnsName} "cd ${remotePath} && pm2 delete all || true && pm2 start npm --name 'lightci-app' -- start && pm2 save"`;
          await this.executeCommand(startCmd);
          logAndConsole('Application started with PM2 successfully');
          
          // Run post-deployment command if specified
          if (config.environmentVariables?.POST_DEPLOY_COMMAND) {
            logAndConsole(`Executing post-deployment command: ${config.environmentVariables.POST_DEPLOY_COMMAND}`);
            const postDeployCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -v -i ${keyPath} ${username}@${publicDnsName} "cd ${remotePath} && ${config.environmentVariables.POST_DEPLOY_COMMAND}"`;
            await this.executeCommand(postDeployCmd);
            logAndConsole('Post-deployment command executed successfully');
          }
          
          logAndConsole(`Deployment to EC2 instance ${config.instanceId} completed successfully`);
          return {
            success: true,
            message: `Successfully deployed to EC2 instance ${config.instanceId}`,
            logs,
            details: {
              instanceId: config.instanceId,
              deployPath: config.ec2DeployPath || '/home/ec2-user/app',
              publicDnsName
            }
          };
        } finally {
          // Clean up temporary directory
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
            logAndConsole('Cleaned up temporary deployment files');
          } catch (error) {
            logAndConsole(`Error cleaning up temporary files: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logAndConsole(`Deployment failed: ${errorMessage}`);
      return {
        success: false,
        message: `EC2 deployment failed: ${errorMessage}`,
        logs
      };
    }
  }
  
  /**
   * Create a tar archive of a directory
   */
  private async createArchive(sourcePath: string, targetPath: string): Promise<void> {
    console.log(`[DeploymentService] Creating archive from ${sourcePath} to ${targetPath}`);
    return new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-czf', targetPath, '-C', sourcePath, '.']);
      
      tar.stdout.on('data', (data: Buffer) => {
        console.log(`[DeploymentService] tar stdout: ${data.toString()}`);
      });
      
      tar.stderr.on('data', (data: Buffer) => {
        console.log(`[DeploymentService] tar stderr: ${data.toString()}`);
      });
      
      tar.on('close', (code: number) => {
        if (code === 0) {
          console.log(`[DeploymentService] Archive created successfully: ${targetPath}`);
          resolve();
        } else {
          console.error(`[DeploymentService] tar process exited with code ${code}`);
          reject(new Error(`tar process exited with code ${code}`));
        }
      });
      
      tar.on('error', (err: Error) => {
        console.error(`[DeploymentService] Error creating archive:`, err);
        reject(err);
      });
    });
  }
  
  /**
   * Execute a shell command
   */
  private async executeCommand(command: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      exec(command, { encoding: 'utf8' }, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }

  private async checkInstanceHealth(instanceId: string, config: DeploymentConfig): Promise<boolean> {
    try {
      console.log(`[DeploymentService] Checking health of instance ${instanceId}`);
      const ec2Client = new EC2Client({
        region: config.region || 'us-east-1',
        credentials: {
          accessKeyId: config.awsAccessKeyId || '',
          secretAccessKey: config.awsSecretAccessKey || ''
        }
      });

      // Check instance status
      const describeCommand = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });
      
      const response = await ec2Client.send(describeCommand);
      const instance = response.Reservations?.[0]?.Instances?.[0];
      
      if (!instance) {
        console.log(`[DeploymentService] Instance ${instanceId} not found`);
        return false;
      }

      // Check if instance is running
      const isRunning = instance.State?.Name === 'running';
      
      if (!isRunning) {
        console.log(`[DeploymentService] Instance ${instanceId} is not running (state: ${instance.State?.Name})`);
        return false;
      }

      // Check instance status
      const describeStatusCommand = new DescribeInstanceStatusCommand({
        InstanceIds: [instanceId]
      });
      
      const statusResponse = await ec2Client.send(describeStatusCommand);
      const instanceStatus = statusResponse.InstanceStatuses?.[0];
      
      if (!instanceStatus) {
        console.log(`[DeploymentService] No status information available for instance ${instanceId}`);
        return false;
      }

      // Check both system and instance status
      const isHealthy = instanceStatus.InstanceStatus?.Status === 'ok' &&
                       instanceStatus.SystemStatus?.Status === 'ok';

      console.log(`[DeploymentService] Instance ${instanceId} health check: ${isHealthy ? 'healthy' : 'unhealthy'}`);
      
      // If instance is healthy, try to verify the application is running
      if (isHealthy) {
        try {
          // Try to connect to the instance on port 3000 (or your app's port)
          const appCheckCommand = `nc -z -w5 ${instance.PublicDnsName} 3000`;
          await execAsync(appCheckCommand);
          console.log(`[DeploymentService] Application is running on instance ${instanceId}`);
          return true;
        } catch (error) {
          console.log(`[DeploymentService] Application is not running on instance ${instanceId}`);
          return false;
        }
      }

      return isHealthy;
    } catch (error) {
      console.error(`[DeploymentService] Error checking instance health:`, error);
      return false;
    }
  }
}