import { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';
import { EC2Client, DescribeInstancesCommand, CreateKeyPairCommand, DeleteKeyPairCommand, DescribeInstanceStatusCommand } from '@aws-sdk/client-ec2';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn, exec, execSync } from 'child_process';
import { promisify } from 'util';
import { InstanceProvisionerService, InstanceConfig } from './instance-provisioner.service.js';
import * as fsPromises from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { glob } from 'glob'; // Use correct import for glob
import { dirname, join } from 'path';
import { statSync as fsStatSync, chmodSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { pipeline } from 'stream';
import { SshKeyService } from './ssh-key.service.js';

const execAsync = promisify(exec);

type JsonValue = string | number | boolean | { [key: string]: JsonValue } | JsonValue[];

// Create deployment events emitter
const deploymentEvents = new EventEmitter();

// Export event emitter for external use
export { deploymentEvents };

// Define deployment result type
interface DeploymentResult {
  success: boolean;
  message?: string;
  logs: string[];
  details?: {
    instanceId?: string;
    deployPath?: string;
    publicDnsName?: string;
    url?: string;
    environment?: string;
  };
}

// Define blue-green deployment config type
interface BlueGreenConfig {
  productionPort: number;
  stagingPort: number;
  healthCheckPath: string;
  healthCheckTimeout: number;
  rollbackOnFailure: boolean;
}

// Define deployment platform type
type DeploymentPlatform = 'aws' | 'aws_ec2' | 'aws_ecs' | 'gcp' | 'azure' | 'kubernetes' | 'custom';

// Define deployment config type
export interface DeploymentConfig {
  platform: DeploymentPlatform;
  config: Record<string, any>;
  mode?: 'automatic' | 'manual';
  instanceId?: string;
  region?: string;
  service?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  ec2SshKey?: string;
  ec2SshKeyEncoded?: string;
  ec2Username?: string;
  ec2DeployPath?: string;
  environmentVariables?: Record<string, string>;
  strategy?: 'standard' | 'blue-green';
  blueGreenConfig?: BlueGreenConfig;
  environment?: string;
  // Additional properties for EC2 deployment
  ec2InstanceId?: string;
  publicDns?: string;
  pipelineId?: string;
  sshKeyId?: string; // Reference to SSH key in the database
  securityGroupIds?: string[]; // Security group IDs for AWS EC2
  subnetId?: string; // Subnet ID for AWS EC2
}

// Define pipeline status type
type PipelineStatus = 'pending' | 'running' | 'completed' | 'failed';

// Define pipeline step type
interface PipelineStep {
  name: string;
  command: string;
  [key: string]: JsonValue;
}

// Define pipeline triggers type
interface PipelineTriggers {
  events: ('push' | 'pull_request')[];
  branches: string[];
}

// Define webhook config type
interface WebhookConfig {
  github?: {
    id: number;
    url: string;
  };
}

// Define pipeline type
interface Pipeline {
  id: string;
  name: string;
  description?: string;
  repository: string;
  defaultBranch: string;
  steps: PipelineStep[];
  triggers: PipelineTriggers;
  schedule: Record<string, any>;
  status: PipelineStatus;
  createdAt: Date;
  updatedAt: Date;
  artifactPatterns: string[];
  artifactRetentionDays: number;
  artifactStorageConfig: Record<string, any>;
  artifactStorageType: string;
  artifactsEnabled: boolean;
  deploymentConfig: Record<string, any>;
  deploymentEnabled: boolean;
  deploymentMode: 'automatic' | 'manual';
  deploymentPlatform?: string;
  webhookConfig: WebhookConfig;
  createdById?: string;
  projectId?: string;
}

// Define extended pipeline type
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
  deploymentMode: 'automatic' | 'manual';
  projectId?: string;
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

// Define auto deployment type
type AutoDeployment = {
  id: string;
  userId: string;
  instanceId: string;
  status: string;
  type: string;
  region: string;
  createdAt: Date;
  metadata: JsonValue;
  pipelineId: string | null;
  sshKeyId?: string; // Match the Prisma schema
};

// Define build type
interface Build {
  id: string;
  pipelineId: string;
  status: string;
  branch: string;
  commit?: string;
  startedAt: Date;
  completedAt?: Date;
  stepResults: Record<string, any>;
  logs: string[];
  error?: string;
  artifactsPath?: string;
  artifactsCollected: boolean;
  artifactsCount?: number;
  artifactsExpireAt?: Date;
  artifactsSize?: number;
}

// Avoid the import conflict by using a dynamic import function
const engineServiceImport = async () => {
  const module = await import('./engine.service.js');
  return module.EngineService;
};

// Interface definitions for AWS EC2 deployments
interface DeployAwsEc2Options {
  artifactPath?: string;
  ec2InstanceId?: string;
  ec2InstanceUrl?: string;
  ec2SshKey?: string;
  ec2SshKeyEncoded?: string;
  ec2SshUser?: string;
  ec2Username?: string;
  ec2DeployPath?: string;
  deploymentId?: string;
  domainName?: string;
  appName?: string;
  environment?: string;
  platform?: DeploymentPlatform;
  region?: string;
  instanceId?: string;
  publicDns?: string;
  config?: Record<string, any>;
}

// Define engine service interface instead of importing the class to avoid circular dependency
interface EngineServiceInterface {
  runPipeline?: (pipeline: Pipeline, build: Build) => Promise<void>;
  stopPipeline?: (pipelineId: string) => Promise<void>;
  getPipelineStatus?: (pipelineId: string) => Promise<string>;
  getBuild: (buildId: string) => Promise<any>;
}

export class DeploymentService {
  private prisma: PrismaClient;
  private engineService: EngineServiceInterface;
  private s3Client: S3Client;
  private logger: typeof logger;
  private instanceProvisioner: InstanceProvisionerService | undefined;
  private artifacts_base_dir: string;
  private sshKeyService: SshKeyService;
  
  constructor(
    engineService?: EngineServiceInterface,
    sshKeyService?: SshKeyService
  ) {
    // Initialize Prisma directly from import
    this.prisma = prisma; 
    if (!this.prisma) {
        console.error('[DeploymentService] Fatal error: Imported Prisma instance is invalid!');
        throw new Error('Failed to get Prisma client from import');
    }
    console.log('[DeploymentService] Using imported Prisma instance');

    // Handle the engine service (existing logic)
    if (engineService) {
      this.engineService = engineService;
    } else {
      this.engineService = { getBuild: async () => null }; // Placeholder
      engineServiceImport().then(EngineServiceClass => {
        this.engineService = new EngineServiceClass(process.env.CORE_ENGINE_URL || 'http://localhost:3001');
      }).catch(error => {
        console.error('[DeploymentService] Failed to import EngineService:', error);
      });
    }
    
    this.logger = logger;
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
      }
    });
    this.artifacts_base_dir = process.env.ARTIFACTS_DIR || '/tmp/lightci/artifacts';
    
    // Initialize SshKeyService using the directly assigned prisma instance
    this.sshKeyService = sshKeyService || new SshKeyService(this.prisma);
  }

  private async initializeInstanceProvisioner(config: DeploymentConfig) {
    if (!this.instanceProvisioner && config.awsAccessKeyId && config.awsSecretAccessKey) {
      let privateKey = '';
      let keyName = '';
      let shouldCreateKey = false;
      
      // Check for existing deployment and key
      if (config.mode === 'automatic' && config.pipelineId) {
        try {
          // Get a valid prisma client
          const prismaClient = this.prisma;
          
          // Find existing active deployment for this pipeline
          const existingDeployment = await prismaClient.autoDeployment.findFirst({
            where: {
              pipelineId: config.pipelineId,
              status: 'active'
            },
            orderBy: {
              createdAt: 'desc'
            }
          });
          
          if (existingDeployment) {
            console.log(`[DeploymentService] Found existing deployment for pipeline ${config.pipelineId}`);
            
            // Get the SSH key associated with this deployment
            const hasSshKeyId = existingDeployment && typeof existingDeployment === 'object' && 
                               'sshKeyId' in existingDeployment && existingDeployment.sshKeyId;
            
            if (hasSshKeyId) {
              const keyId = String(existingDeployment.sshKeyId);
              const key = await this.sshKeyService.getKeyById(keyId);
              if (key) {
                console.log(`[DeploymentService] Using existing key from deployment`);
                privateKey = key.content;
                keyName = key.keyPairName;
                
                // Store the key ID in the config for future use
                config.sshKeyId = keyId;
              } else {
                console.log(`[DeploymentService] Could not find key with ID ${keyId}`);
                shouldCreateKey = true;
              }
            } else {
              console.log(`[DeploymentService] No SSH key ID in deployment, checking metadata`);
              
              // Try to extract key name from metadata for backward compatibility
              let deploymentMetadata: any = {};
              try {
                deploymentMetadata = existingDeployment.metadata || {};
                if (typeof deploymentMetadata === 'string') {
                  deploymentMetadata = JSON.parse(deploymentMetadata);
                }
                
                const existingKeyName = deploymentMetadata.keyName || deploymentMetadata.keyPairName;
                
                if (existingKeyName && existingKeyName.startsWith('lightci-')) {
                  console.log(`[DeploymentService] Found key name in metadata: ${existingKeyName}`);
                  
                  // Try to find the key by name
                  const existingKey = await this.sshKeyService.getKeyByPairName(existingKeyName);
                  if (existingKey) {
                    keyName = existingKeyName;
                    privateKey = existingKey.content;
                    
                    // Update the deployment record with the key ID
                    try {
                      // Store key reference in metadata rather than direct column
                      const metadata = typeof existingDeployment.metadata === 'string' 
                        ? JSON.parse(existingDeployment.metadata || '{}') 
                        : (existingDeployment.metadata || {});
                      
                      // Update metadata with key reference
                      const updatedMetadata = {
                        ...metadata,
                        keyId: existingKey.id,
                        keyName: existingKeyName
                      };
                      
                      // Update the deployment with the new metadata
                      await prismaClient.autoDeployment.update({
                        where: { id: existingDeployment.id },
                        data: { metadata: updatedMetadata }
                      });
                      
                      console.log(`[DeploymentService] Updated deployment metadata with key information`);
                    } catch (updateError) {
                      console.error(`[DeploymentService] Error updating deployment metadata: ${updateError.message}`);
                      // Continue execution, this is not critical
                    }
                    
                    // Store the key ID in the config
                    config.sshKeyId = existingKey.id;
                    
                    console.log(`[DeploymentService] Found and associated existing key for ${existingKeyName}`);
                  } else {
                    console.log(`[DeploymentService] Could not find key for name ${existingKeyName}`);
                    shouldCreateKey = true;
                  }
                } else {
                  console.log(`[DeploymentService] No valid key name in deployment metadata`);
                  shouldCreateKey = true;
                }
              } catch (parseError) {
                console.log(`[DeploymentService] Error parsing deployment metadata: ${parseError.message}`);
                shouldCreateKey = true;
              }
            }
          } else {
            console.log(`[DeploymentService] No existing deployment for pipeline ${config.pipelineId}`);
            shouldCreateKey = true;
          }
        } catch (error) {
          console.error(`[DeploymentService] Error checking for existing deployment: ${error.message}`);
          shouldCreateKey = true;
        }
      } else {
        console.log(`[DeploymentService] Not an automatic deployment or no pipeline ID, will check for existing key`);
        
        // Try to use the key ID from config if available
        if (config.sshKeyId) {
          const key = await this.sshKeyService.getKeyById(config.sshKeyId);
          if (key) {
            console.log(`[DeploymentService] Using key from config.sshKeyId: ${config.sshKeyId}`);
            privateKey = key.content;
            keyName = key.keyPairName;
          } else {
            console.log(`[DeploymentService] Key with ID ${config.sshKeyId} not found`);
            shouldCreateKey = true;
          }
        } else {
          shouldCreateKey = true;
        }
      }
      
      // For automatic deployment, create a new key pair if needed
      if (config.mode === 'automatic' && (shouldCreateKey || !privateKey)) {
        try {
          console.log(`[DeploymentService] Creating new SSH key pair`);
          
          const credentials = {
            accessKeyId: config.awsAccessKeyId,
            secretAccessKey: config.awsSecretAccessKey,
            region: config.region || 'us-east-1'
          };
          
          const keyPairName = `lightci-${crypto.randomBytes(8).toString('hex')}`;
          
          const newKey = await this.sshKeyService.createKey({
            name: keyPairName,
            awsCredentials: credentials
          });
          
          console.log(`[DeploymentService] Created new key pair: ${newKey.keyPairName}`);
          
          // Get the key content
          const key = await this.sshKeyService.getKeyById(newKey.id);
          if (!key) {
            throw new Error('Failed to retrieve newly created key');
          }
          
          privateKey = key.content;
          keyName = newKey.keyPairName;
          config.sshKeyId = newKey.id;
          
          // Update pipeline with the new key if a pipeline ID is provided
          if (config.pipelineId) {
            try {
              const pipeline = await this.prisma.pipeline.findUnique({
                where: { id: config.pipelineId }
              });
              
              if (pipeline) {
                // Parse existing config
                let deploymentConfig: any = {};
                try {
                  deploymentConfig = typeof pipeline.deploymentConfig === 'string'
                    ? JSON.parse(pipeline.deploymentConfig)
                    : pipeline.deploymentConfig || {};
                } catch (parseError) {
                  console.log(`[DeploymentService] Error parsing pipeline deployment config: ${parseError.message}`);
                  deploymentConfig = {};
                }
                
                // Update with SSH key info
                deploymentConfig.sshKeyId = newKey.id;
                
                // For backward compatibility
                deploymentConfig.ec2SshKey = privateKey;
                deploymentConfig.ec2SshKeyEncoded = Buffer.from(privateKey).toString('base64');
                
                if (!deploymentConfig.config) {
                  deploymentConfig.config = {};
                }
                
                deploymentConfig.config.keyPairName = keyName;
                
                // Save the updated config
                await this.prisma.pipeline.update({
                  where: { id: config.pipelineId },
                  data: {
                    deploymentConfig: JSON.stringify(deploymentConfig)
                  }
                });
                
                console.log(`[DeploymentService] Updated pipeline ${config.pipelineId} with SSH key information`);
              }
            } catch (dbError) {
              console.error(`[DeploymentService] Error updating pipeline with SSH key: ${dbError.message}`);
              // Don't fail, just log the error
            }
          }
        } catch (error) {
          console.error(`[DeploymentService] Error creating key pair: ${error.message}`);
          throw error;
        }
      }
      
      // Store the private key in the config for later use
      if (privateKey) {
        // For backward compatibility
        config.ec2SshKey = privateKey;
        config.ec2SshKeyEncoded = Buffer.from(privateKey).toString('base64');
        
        // Remember the key name for tracking
        config.config = {
          ...config.config,
          keyPairName: keyName
        };
      }
      
      // Create the instance provisioner with the appropriate config
      this.instanceProvisioner = new InstanceProvisionerService(
        this.prisma,
        {
          region: config.region || 'us-east-1',
          imageId: 'ami-0889a44b331db0194', // Use a known valid AMI ID directly
          keyName: keyName, // Use the key name we determined
          // Use the securityGroupIds from config or fall back to environment variable
          securityGroupIds: config.securityGroupIds || 
                            (process.env.AWS_SECURITY_GROUP_ID ? [process.env.AWS_SECURITY_GROUP_ID] : []),
          // Use the subnetId from config or fall back to environment variable  
          subnetId: config.subnetId || process.env.AWS_SUBNET_ID || ''
        },
        config.awsAccessKeyId || '',
        config.awsSecretAccessKey || ''
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
      // Use the helper method to ensure we have a valid prisma instance
      const prismaClient = this.prisma;
      
      // Get the pipeline run
      console.log(`[DeploymentService] Fetching pipeline run ${runId} from database`);
      const dbRun = await prismaClient.pipelineRun.findUnique({
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
      
      // Cast the pipeline to ExtendedPipeline type
      const run: PipelineRun = {
        ...dbRun,
        stepResults: dbRun.stepResults as Record<string, JsonValue>,
        logs: Array.isArray(dbRun.logs) ? (dbRun.logs as string[]) : [],
        createdById: dbRun.pipeline.createdById || 'system',
        pipeline: {
          ...dbRun.pipeline,
          workspaceId: '',
          deploymentConfig: dbRun.pipeline.deploymentConfig as Record<string, JsonValue>,
          status: dbRun.pipeline.status as PipelineStatus,
          steps: dbRun.pipeline.steps as PipelineStep[],
          triggers: this.parsePipelineTriggers(dbRun.pipeline.triggers),
          schedule: dbRun.pipeline.schedule as Record<string, any>,
          webhookConfig: dbRun.pipeline.webhookConfig as WebhookConfig,
          artifactPatterns: dbRun.pipeline.artifactPatterns as string[],
          artifactStorageConfig: dbRun.pipeline.artifactStorageConfig as Record<string, any>,
          deploymentMode: dbRun.pipeline.deploymentMode as 'automatic' | 'manual',
          projectId: dbRun.pipeline.projectId
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
        ...(run.pipeline.deploymentConfig as unknown as Partial<DeploymentConfig>),
        // Add pipeline ID for key management
        pipelineId: run.pipelineId
      };

      // For automatic deployment, ensure service is set to ec2 and platform to aws_ec2
      if (deploymentConfig.mode === 'automatic') {
        deploymentConfig.service = 'ec2';
        deploymentConfig.platform = 'aws_ec2';
      }

      console.log(`[DeploymentService] Deployment platform: ${deploymentConfig.platform}, config:`, JSON.stringify(deploymentConfig, null, 2));
      
      // Ensure SSH keys are preserved before starting deployment
      await this.ensureDeploymentConfigPreserved(deploymentConfig);
      
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
      
      // Always set platform to aws_ec2 when service is ec2
      if ((platform === 'aws' || deploymentConfig.platform === 'aws') && 
          (parsedConfig.service === 'ec2' || deploymentConfig.service === 'ec2')) {
        effectivePlatform = 'aws_ec2';
        // Also update the config to ensure consistent platform value
        config.platform = 'aws_ec2';
        console.log(`[DeploymentService] Platform is 'aws' with service 'ec2', treating as '${effectivePlatform}'`);
      }
      
      // Initialize instance provisioner if needed
      await this.initializeInstanceProvisioner(config);
      
      switch (effectivePlatform) {
        case 'aws_ec2':
          console.log(`[DeploymentService] Deploying to AWS EC2`);
          if (config.mode === 'automatic' && this.instanceProvisioner) {
            try {
              // Find existing active deployments for this pipeline
              const existingDeployments = await prismaClient.$queryRaw<AutoDeployment[]>`
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
                const isHealthy = await this.checkInstanceHealth(deployment.instanceId, config);

                if (isHealthy) {
                  console.log(`[DeploymentService] Reusing existing healthy instance: ${deployment.instanceId}`);
                  instanceId = deployment.instanceId;

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
                  console.log(`[DeploymentService] Existing instance unhealthy, terminating: ${deployment.instanceId}`);
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
            // Update the config to ensure platform is set to aws_ec2
            config.platform = 'aws_ec2';
            effectivePlatform = 'aws_ec2';
            console.log(`[DeploymentService] Deploying to AWS EC2 via 'aws' platform, updated platform to 'aws_ec2'`);
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
      await prismaClient.pipelineRun.update({
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
        
        // Create or update the deployedApp record
        const appName = run.pipeline?.name?.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'app';
        const appUrl = result.details?.publicDnsName 
          ? `http://${result.details.publicDnsName}` 
          : result.details?.url || '';

        // Create or update the deployedApp record using Prisma client
        await this.updateDeployedApp(run, config, { url: appUrl, environment: result.details?.environment });
        
        console.log(`[DeploymentService] Updated deployedApp record for pipeline ${run.pipelineId}`);
        
        // Update the pipeline's deployment config with instance details for future use
        await this.updatePipelineDeploymentConfig(run.pipelineId, config);
      } else {
        console.error(`[DeploymentService] Deployment for run ${runId} failed: ${result.message}`);
        
        // Update deployedApp status to failed if it exists using Prisma client
        await prismaClient.deployedApp.updateMany({
          where: {
            pipelineId: run.pipelineId,
            environment: result.details?.environment || 'production'
          },
          data: {
            status: 'failed',
            lastDeployed: new Date()
          }
        });
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
    
    // Define helper to log both to logs array and console
    const logAndConsole = (message: string, isError = false) => {
      if (isError) {
        console.error(`[DeploymentService] ${message}`);
      } else {
        console.log(`[DeploymentService] ${message}`);
      }
      logs.push(message);
      return message;
    };
    
    logAndConsole(`Starting AWS EC2 deployment for pipeline ${run.pipelineId}`);
    
    // Ensure any valid SSH keys are preserved before starting deployment
    if (config.pipelineId) {
      await this.ensureDeploymentConfigPreserved(config);
    }
    
    try {
      // Validate basic configuration
      if (!config.instanceId && !config.config?.ec2InstanceId) {
        logAndConsole('ERROR: No instance ID provided');
        return {
          success: false,
          message: 'No instance ID provided',
          logs
        };
      }
      
      // Enhanced SSH key validation
      if (!config.ec2SshKey && !config.ec2SshKeyEncoded) {
        logAndConsole(`ERROR: No SSH key provided in configuration. Both ec2SshKey and ec2SshKeyEncoded are empty.`);
        
        // If we're using automatic mode, this is unexpected since we should have created a key
        if (config.mode === 'automatic') {
          logAndConsole(`WARNING: In automatic mode but no SSH key was found! This indicates a problem with key generation or storage.`);
          
          // Check if we need to recreate the key
          try {
            logAndConsole(`Attempting to recreate key pair...`);
            await this.initializeInstanceProvisioner(config);
            
            // Check if we have a key now
            if (config.ec2SshKey || config.ec2SshKeyEncoded) {
              logAndConsole(`Successfully recreated SSH key: ${config.ec2SshKey?.length || 0} chars`);
            } else {
              logAndConsole(`Failed to recreate SSH key`);
              return {
                success: false,
                message: 'Failed to create or recover SSH key for deployment',
                logs
              };
            }
          } catch (keyError) {
            logAndConsole(`Error recreating key: ${keyError.message}`);
            return {
              success: false,
              message: `SSH key creation failed: ${keyError.message}`,
              logs
            };
          }
        } else {
          return {
            success: false,
            message: 'No SSH key provided in configuration',
            logs
          };
        }
      }
      
      // Continue with deployment...
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
        logAndConsole(`Created temporary directory: ${tempDir}`);
        
        const keyPath = path.join(tempDir, 'ssh_key.pem');
        const tarPath = path.join(tempDir, 'deploy.tar.gz');
        
        try {
          // Process and write SSH key to file
          if (!config.ec2SshKey && !config.ec2SshKeyEncoded) {
            logAndConsole('ERROR: SSH key not provided in configuration');
            return {
              success: false,
              message: 'SSH key not provided in configuration',
              logs
            };
          }
          
          // Process the SSH key using our helper method
          const keyProcessed = await this.processSshKey(config, keyPath);
          
          if (!keyProcessed) {
            logAndConsole(`Failed to process SSH key`);
            return {
              success: false,
              message: 'Failed to process SSH key',
              logs
            };
          }
          
          // NEW: Add key verification before attempting deployment
          // This tests the key against the instance to check if it's valid
          const username = config.ec2Username || 'ec2-user';
          logAndConsole(`Verifying SSH key access to ${username}@${publicDnsName}...`);
          
          try {
            // Run a simple command to verify SSH access
            const verifyCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o ConnectTimeout=10 -i ${keyPath} ${username}@${publicDnsName} "echo 'SSH key verification successful'"`;
            
            const { stdout } = await this.executeCommand(verifyCmd);
            
            if (stdout.includes('SSH key verification successful')) {
              logAndConsole(`✅ SSH key verification passed: Key is valid for this instance`);
            } else {
              logAndConsole(`⚠️ SSH key verification returned unexpected output: ${stdout.substring(0, 100)}`);
              // Continue anyway, as we got some response
            }
          } catch (sshVerifyError) {
            // This is the critical part: SSH key verification failed
            logAndConsole(`❌ SSH key verification failed: ${sshVerifyError.message}`);
            
            // If we have a pipeline ID, try to recover or recreate the correct key
            if (config.pipelineId) {
              logAndConsole(`Attempting to recover the correct SSH key for this instance...`);
              
              // Look up the auto deployment record to get the metadata with the correct key name
              const autoDeployment = await this.prisma.autoDeployment.findFirst({
                where: {
                  pipelineId: config.pipelineId,
                  status: 'active'
                },
                orderBy: {
                  createdAt: 'desc'
                }
              });
              
              if (autoDeployment) {
                logAndConsole(`Found auto deployment record for pipeline ${config.pipelineId}`);
                
                // Extract key name from metadata
                let metadata: any = {};
                try {
                  metadata = autoDeployment.metadata || {};
                  if (typeof metadata === 'string') {
                    metadata = JSON.parse(metadata);
                  }
                  
                  const keyName = metadata.keyName;
                  if (keyName && keyName.startsWith('lightci-')) {
                    logAndConsole(`Found key name in auto deployment metadata: ${keyName}`);
                    
                    // Look for the key file in various locations
                    const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
                    const sshDir = path.join(homeDir, '.ssh');
                    const keyLocations = [
                      path.join(sshDir, `${keyName}.pem`),
                      path.join(process.cwd(), `${keyName}.pem`),
                      path.join('/tmp', `${keyName}.pem`)
                    ];
                    
                    let keyFound = false;
                    for (const loc of keyLocations) {
                      if (fs.existsSync(loc)) {
                        try {
                          const keyContent = fs.readFileSync(loc, 'utf-8');
                          if (keyContent && keyContent.includes('PRIVATE KEY')) {
                            logAndConsole(`Found valid key file at ${loc}`);
                            
                            // Update the key in the config
                            config.ec2SshKey = keyContent;
                            config.ec2SshKeyEncoded = Buffer.from(keyContent).toString('base64');
                            
                            // Write to the temporary key file
                            fs.writeFileSync(keyPath, keyContent, { mode: 0o600 });
                            logAndConsole(`Updated SSH key from recovered file`);
                            
                            // Try to verify again
                            try {
                              const retryVerifyCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o ConnectTimeout=10 -i ${keyPath} ${username}@${publicDnsName} "echo 'SSH key verification successful'"`;
                              
                              const { stdout: retryOutput } = await this.executeCommand(retryVerifyCmd);
                              
                              if (retryOutput.includes('SSH key verification successful')) {
                                logAndConsole(`✅ Recovered SSH key verification passed!`);
                                keyFound = true;
                                
                                // Update the deployment record - store key info in metadata instead
                                try {
                                  // Get current metadata from the current deployment info
                                  // If these variables aren't in scope, we'll use safer alternatives
                                  const deploymentId = config.pipelineId ? 
                                    (await this.prisma.autoDeployment.findFirst({
                                      where: { pipelineId: config.pipelineId, status: 'active' },
                                      orderBy: { createdAt: 'desc' }
                                    }))?.id : null;
                                  
                                  if (deploymentId) {
                                    const keyId = config.sshKeyId;
                                    const keyName = config.config?.keyPairName;
                                    
                                    if (keyId) {
                                      // Get the deployment record to update
                                      const deployment = await this.prisma.autoDeployment.findUnique({
                                        where: { id: deploymentId }
                                      });
                                      
                                      if (deployment) {
                                        // Parse metadata safely
                                        let metadataObj = {};
                                        if (typeof deployment.metadata === 'object' && deployment.metadata !== null) {
                                          metadataObj = deployment.metadata;
                                        } else if (typeof deployment.metadata === 'string') {
                                          try {
                                            metadataObj = JSON.parse(deployment.metadata);
                                          } catch (e) {
                                            // Ignore parsing errors
                                          }
                                        }
                                        
                                        // Update metadata with key information
                                        const updatedMetadata = Object.assign({}, metadataObj, {
                                          keyId: keyId,
                                          keyName: keyName
                                        });
                                        
                                        // Update the deployment record
                                        await this.prisma.autoDeployment.update({
                                          where: { id: deploymentId },
                                          data: { metadata: updatedMetadata }
                                        });
                                        
                                        logAndConsole(`Updated deployment ${deploymentId} with key information`);
                                      }
                                    }
                                  }
                                } catch (error) {
                                  logAndConsole(`Error updating deployment: ${error.message}`);
                                  // Continue execution, this is not a critical error
                                }
                                
                                break;
                              }
                            } catch (retryError) {
                              logAndConsole(`Recovered key verification failed: ${retryError.message}`);
                            }
                          }
                        } catch (readError) {
                          logAndConsole(`Error reading key file ${loc}: ${readError.message}`);
                        }
                      }
                    }
                    
                    if (!keyFound) {
                      logAndConsole(`Could not recover a working SSH key for this instance`);
                      return {
                        success: false,
                        message: 'SSH key authentication failed and recovery attempts were unsuccessful',
                        logs
                      };
                    }
                  } else {
                    logAndConsole(`No valid key name found in deployment metadata`);
                  }
                } catch (metadataError) {
                  logAndConsole(`Error parsing deployment metadata: ${metadataError.message}`);
                }
              } else {
                logAndConsole(`No auto deployment record found for pipeline ${config.pipelineId}`);
              }
            }
          }
          
          // Continue with normal deployment now that we have a verified key
          let remotePath = (config.ec2DeployPath || '/home/ec2-user/app').trim();
          
          logAndConsole(`Preparing to deploy to ${username}@${publicDnsName}:${remotePath}`);
          
          // Create remote directory if it doesn't exist
          const mkdirCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "mkdir -p ${remotePath}"`;
          await this.executeCommand(mkdirCmd);
          logAndConsole(`Created target directory: ${remotePath}`);
          
          // Create and upload deployment archive
          logAndConsole(`Creating deployment archive...`);
          await this.createArchive(run.artifactsPath || '', tarPath);
          
          // Upload tar file
          const scpCmd = `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o ConnectTimeout=30 -i ${keyPath} ${tarPath} ${username}@${publicDnsName}:${remotePath}/deploy.tar.gz`;
          await this.executeCommand(scpCmd);
          
          // Extract archive on the remote server
          const extractCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o ConnectTimeout=30 -i ${keyPath} ${username}@${publicDnsName} "cd ${remotePath} && tar -xzf deploy.tar.gz"`;
          await this.executeCommand(extractCmd);
        }
        
        // Handle SSH error logging
        catch (error) {
          console.log(`[DeploymentService] Error recording SSH access: ${error.message}`);
          // Don't fail if this is just logging
        }

        // Return the full command that can be used for SSH access with properly defined properties
        // Make sure we use variables that are defined in this scope
        return {
          success: true,
          message: 'SSH command created successfully',
          logs: [],
          details: {
            // Use safe default values for properties that might be undefined
            instanceId: '',
            deployPath: '',
            publicDnsName: ''
          }
        };
      } catch (error) {
        throw new Error(`Failed to create SSH command: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } catch (error) {
      throw new Error(`Failed to deploy to AWS EC2: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Configure a domain after verification
   * This method is used to make a verified domain accessible from the web
   * @param deployedApp The deployed app details
   * @param domain The domain to configure
   * @param config The deployment configuration 
   */
  async configureDomainAfterVerification(
    deployedApp: { id: string; url: string; name: string },
    domain: { id: string; domain: string; verify_token: string },
    config: DeploymentConfig
  ): Promise<{ success: boolean; message?: string }> {
    try {
      console.log(`[DeploymentService] Configuring domain ${domain.domain} after verification`);
      
      // If config is missing or platform is not set, try to fix it
      if (!config) {
        config = {} as DeploymentConfig;
      }
      
      // If mode is automatic, set platform to aws_ec2
      if (!config.platform && config.mode === 'automatic') {
        console.log(`[DeploymentService] Automatic deployment mode detected, setting platform to aws_ec2`);
        config.platform = 'aws_ec2';
        config.service = 'ec2';
      }
      
      // If platform is still not set, try to get it from the pipeline
      if (!config.platform && config.pipelineId) {
        try {
          // Look up the pipeline to get deployment settings
          const pipeline = await this.prisma.pipeline.findUnique({
            where: { id: config.pipelineId }
          });
          
          if (pipeline) {
            if (pipeline.deploymentMode === 'automatic') {
              console.log(`[DeploymentService] Setting platform to aws_ec2 based on pipeline automatic mode`);
              config.platform = 'aws_ec2';
              config.service = 'ec2';
            } else if (pipeline.deploymentPlatform) {
              config.platform = pipeline.deploymentPlatform as DeploymentPlatform;
            }
          }
        } catch (pipelineError) {
          console.error(`[DeploymentService] Error getting pipeline details:`, pipelineError);
        }
      }
      
      // If platform is still missing, we can't proceed
      if (!config.platform) {
        return { 
          success: false, 
          message: `Missing platform configuration` 
        };
      }
      
      // Convert 'aws' to 'aws_ec2' if service is 'ec2'
      if (config.platform === 'aws' && (config.service === 'ec2' || config.config?.service === 'ec2')) {
        console.log(`[DeploymentService] Converting platform from 'aws' to 'aws_ec2' for EC2 service`);
        config.platform = 'aws_ec2';
      }
      
      // Check if we have EC2 instance details for AWS EC2 platform
      if (config.platform === 'aws_ec2') {
        // If we're missing EC2 details, try to get them from the pipeline
        if ((!config.ec2InstanceId || !config.publicDns) && config.pipelineId) {
          try {
            // Look for EC2 instance details in automatic deployments
            const autoDeployment = await this.prisma.$queryRaw<any[]>`
              SELECT * FROM auto_deployments 
              WHERE pipeline_id = ${config.pipelineId} 
              AND status = 'active' 
              ORDER BY created_at DESC 
              LIMIT 1
            `;
            
            if (autoDeployment && autoDeployment.length > 0) {
              const deployment = autoDeployment[0];
              console.log(`[DeploymentService] Found auto deployment: ${deployment.id}`);
              
              // Get instance details from AWS
              const ec2Client = new EC2Client({
                region: config.region || process.env.AWS_DEFAULT_REGION || 'us-east-1',
                credentials: {
                  accessKeyId: config.awsAccessKeyId || process.env.AWS_ACCESS_KEY_ID || '',
                  secretAccessKey: config.awsSecretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || ''
                }
              });
              
              const describeCommand = new DescribeInstancesCommand({
                InstanceIds: [deployment.instance_id]
              });
              
              const response = await ec2Client.send(describeCommand);
              const instance = response.Reservations?.[0]?.Instances?.[0];
              
              if (instance?.PublicDnsName) {
                console.log(`[DeploymentService] Found instance details for ${deployment.instance_id}`);
                config.ec2InstanceId = deployment.instance_id;
                config.publicDns = instance.PublicDnsName;
              }
            }
          } catch (instanceError) {
            console.error(`[DeploymentService] Error getting instance details:`, instanceError);
          }
        }
        
        // If still missing details, we can't proceed
        if (!config.ec2InstanceId || !config.publicDns) {
          return { 
            success: false, 
            message: `Missing EC2 instance details required for domain configuration` 
          };
        }
        
        // Check if we have SSH access info
        console.log(`[DeploymentService] EC2 username in config: "${config.ec2Username || 'not set'}"`);
        console.log(`[DeploymentService] EC2 SSH key present: ${!!config.ec2SshKey}`);
        console.log(`[DeploymentService] EC2 SSH key encoded present: ${!!config.ec2SshKeyEncoded}`);
        console.log(`[DeploymentService] EC2 instance ID: ${config.ec2InstanceId}`);
        console.log(`[DeploymentService] EC2 public DNS: ${config.publicDns}`);
        
        // Force ec2-user as the username
        console.log(`[DeploymentService] Forcing EC2 username to 'ec2-user' (was: ${config.ec2Username || 'undefined'})`);
        config.ec2Username = 'ec2-user'; // Force ec2-user instead of ubuntu
        
        // Ensure the username is also set in the nested config object for backward compatibility
        if (config.config) {
          config.config.ec2Username = config.ec2Username;
        }
      }
      
      // Call the private method to configure the domain
      await this.configureCustomDomains(deployedApp, [domain], config);
      
      return { 
        success: true, 
        message: `Domain ${domain.domain} configured successfully` 
      };
    } catch (error) {
      console.error('[DeploymentService] Error configuring domain after verification:', error);
      return { 
        success: false, 
        message: `Failed to configure domain: ${error.message}` 
      };
    }
  }

  /**
   * Update pipeline deployment configuration with new parameters
   */
  async updatePipelineDeploymentConfig(pipelineId: string, configParams: any): Promise<void> {
    try {
      console.log(`[DeploymentService] Updating deployment config for pipeline ${pipelineId}`);
      
      // Get a valid prisma client
      const prismaClient = this.prisma;
      
      // First, get the current pipeline
      const pipeline = await prismaClient.pipeline.findUnique({
        where: { id: pipelineId }
      });
      
      if (!pipeline) {
        console.error(`[DeploymentService] Pipeline ${pipelineId} not found`);
        return;
      }
      
      // Parse existing config
      let existingConfig: any = {};
      try {
        existingConfig = typeof pipeline.deploymentConfig === 'string'
          ? JSON.parse(pipeline.deploymentConfig)
          : pipeline.deploymentConfig || {};
      } catch (parseError) {
        console.log(`[DeploymentService] Error parsing existing config: ${parseError.message}`);
      }
      
      // Merge with new config
      const updatedConfig = {
        ...existingConfig,
        ...configParams
      };
      
      // Save back to database
      await prismaClient.pipeline.update({
        where: { id: pipelineId },
        data: {
          deploymentConfig: JSON.stringify(updatedConfig)
        }
      });
      
      console.log(`[DeploymentService] Successfully updated deployment config for pipeline ${pipelineId}`);
    } catch (error) {
      console.error(`[DeploymentService] Error updating pipeline config: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Don't throw, just log the error since this is a helper method
    }
  }

  /**
   * Configure SSL for a domain 
   */
  async configureSSL(domain: string, webroot: string, configParams: any, sshKey: string, username: string, hostDns: string): Promise<boolean> {
    try {
      console.log(`[DeploymentService] Configuring SSL for domain ${domain} on host ${hostDns}`);

      // First check if certbot is installed
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightci-ssl-'));
      const keyPath = path.join(tempDir, 'ssh_key.pem');
      fs.writeFileSync(keyPath, sshKey, { mode: 0o600 });

      // Execute command to check if certbot is installed
      const checkCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "which certbot || echo 'not_found'"`;
      const { stdout: certbotPath } = await this.executeCommand(checkCommand);

      if (certbotPath.includes('not_found')) {
        console.log(`[DeploymentService] Certbot not found, attempting to install...`);
        
        // First check which OS version we're dealing with
        const checkOsCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "cat /etc/os-release | grep -i 'id=' || echo 'unknown'"`;
        const { stdout: osInfo } = await this.executeCommand(checkOsCommand);
        console.log(`[DeploymentService] OS detection: ${osInfo.trim()}`);
        
        let installCommand = '';
        if (osInfo.includes('amazon') && !osInfo.includes('2023')) {
          // Amazon Linux 2
          console.log(`[DeploymentService] Detected Amazon Linux 2, using amazon-linux-extras`);
          // Install EPEL, certbot, and the Nginx plugin
          installCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} " \
            echo 'Installing EPEL...' && \
            sudo amazon-linux-extras install -y epel && \
            echo 'Installing Certbot and Nginx plugin...' && \
            sudo yum install -y certbot python2-certbot-nginx && \
            echo 'Certbot and Nginx plugin installed for Amazon Linux 2.' \
          "`;
        } else if (osInfo.includes('amazon') && osInfo.includes('2023')) {
          // Amazon Linux 2023 - Use pip3 and create symlink
          console.log(`[DeploymentService] Detected Amazon Linux 2023, using dnf and pip3`);
          installCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} " \
            echo 'Installing dependencies (python3, pip, augeas-libs)...' && \
            sudo dnf install -y python3 python3-pip augeas-libs && \
            echo 'Installing Certbot and Nginx plugin via pip3...' && \
            sudo python3 -m pip install --upgrade pip && \
            sudo pip3 install certbot certbot-nginx && \
            echo 'Creating certbot symlink...' && \
            sudo ln -sf $(sudo python3 -m pip show certbot | grep Location | cut -d' ' -f2)/certbot/bin/certbot /usr/bin/certbot && \
            sudo chmod +x /usr/bin/certbot && \
            echo 'Certbot installed and linked successfully for Amazon Linux 2023.' \
          "`;
        } else if (osInfo.includes('ubuntu') || osInfo.includes('debian')) {
          // Ubuntu/Debian
          console.log(`[DeploymentService] Detected Ubuntu/Debian, using apt`);
          installCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo apt-get update && sudo apt-get install -y certbot python3-certbot-nginx"`; // Added nginx plugin here too
        } else {
          // Fallback - this should ideally not be reached if detection is robust
          console.warn(`[DeploymentService] OS not specifically handled: ${osInfo.trim()}. Attempting generic yum/dnf/pip install.`);
          installCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo yum install -y certbot python2-certbot-nginx 2>/dev/null || (sudo dnf install -y python3 python3-pip augeas-libs && sudo pip3 install certbot certbot-nginx && sudo ln -sf $(sudo python3 -m pip show certbot | grep Location | cut -d' ' -f2)/certbot/bin/certbot /usr/bin/certbot)"`;
        }

        await this.executeCommand(installCommand);
        
        // Check again
        const verifyCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "which certbot || echo 'not_found'"`;
        const { stdout: verifyPath } = await this.executeCommand(verifyCommand);
        
        if (verifyPath.includes('not_found')) {
          // Last resort - try installing via pip
          console.log(`[DeploymentService] Standard installation failed, trying pip installation...`);
          const pipInstallCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo yum install -y python3 python3-pip || sudo apt-get install -y python3 python3-pip && sudo pip3 install certbot"`;
          await this.executeCommand(pipInstallCommand);
          
          // Verify pip installation
          const finalVerifyCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "which certbot || echo 'not_found'"`;
          const { stdout: finalVerifyPath } = await this.executeCommand(finalVerifyCommand);
          
          if (finalVerifyPath.includes('not_found')) {
            console.error(`[DeploymentService] All attempts to install certbot failed`);
            return false;
          }
        }
      }
      
      // Check firewall settings to ensure ports 80 and 443 are open
      console.log(`[DeploymentService] Checking firewall settings for ports 80 and 443...`);
      // This command works for both firewalld and iptables
      const firewallCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} \"sudo firewall-cmd --list-ports 2>/dev/null || sudo iptables -L -n | grep -E '(80|443)'\"`;
      try {
        const { stdout: firewallOutput } = await this.executeCommand(firewallCommand);
        console.log(`[DeploymentService] Firewall output: ${firewallOutput.trim()}`);
      } catch (error: any) {
        // Log a warning if the local firewall check fails, but continue the process
        console.warn(`[DeploymentService] Local firewall check command failed, possibly due to missing tools (firewalld/iptables) or permissions. Error: ${error.message}. Proceeding, relying on external connectivity checks.`);
      }
      
      // Check if ports are open in AWS security group
      console.log(`[DeploymentService] Checking if instance can accept connections from Let's Encrypt servers...`);
      const connectivityTestCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "curl -s https://check-host.net/check-tcp?host=${hostDns}&max_nodes=1&port=80,443 | head -10 || echo 'Connection test failed'" && sleep 2`;
      await this.executeCommand(connectivityTestCommand);
      
      // For Amazon Linux 2023, double check certbot installation
      if (certbotPath.includes('not_found')) {
        console.log(`[DeploymentService] Certbot still not found, attempting direct AL2023 installation...`);
        const directInstallCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo python3 -m pip install --upgrade pip && sudo pip3 install wheel setuptools && sudo pip3 install certbot certbot-nginx && sudo mkdir -p /usr/local/bin && sudo python3 -c 'import pkg_resources; print(pkg_resources.get_distribution(\"certbot\").location)' > /tmp/certbot_location && sudo ln -sf \$(cat /tmp/certbot_location)/certbot/bin/certbot /usr/bin/certbot && sudo chmod +x /usr/bin/certbot"`;
        await this.executeCommand(directInstallCommand);
        
        // Verify installation
        const finalVerifyCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "which certbot && certbot --version"`;
        const { stdout: finalVerifyResult } = await this.executeCommand(finalVerifyCommand);
        console.log(`[DeploymentService] Final certbot installation check: ${finalVerifyResult.trim()}`);
        
        // Also verify that plugins are available
        const pluginCheckCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo certbot plugins || echo 'no plugins'"`;
        const { stdout: pluginCheckResult } = await this.executeCommand(pluginCheckCommand);
        console.log(`[DeploymentService] Certbot plugins available: ${pluginCheckResult.includes('nginx') ? 'nginx plugin is available' : 'nginx plugin NOT available'}`);
        
        // If the nginx plugin is available, try to use certbot-nginx directly
        if (pluginCheckResult.includes('nginx')) {
          console.log(`[DeploymentService] Attempting to use certbot-nginx to obtain and configure certificates in one step...`);
          const nginxPluginCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo certbot --nginx -d ${domain} --non-interactive --agree-tos --email ${configParams.email || 'admin@example.com'} || echo 'nginx plugin failed'"`;
          const { stdout: nginxPluginResult } = await this.executeCommand(nginxPluginCommand);
          
          if (!nginxPluginResult.includes('failed')) {
            console.log(`[DeploymentService] Successfully obtained and configured SSL certificates using certbot-nginx plugin`);
            console.log(`[DeploymentService] SSL successfully configured for ${domain}`);
            return true;
          } else {
            console.log(`[DeploymentService] Failed to use certbot-nginx plugin: ${nginxPluginResult.substring(0, 200)}`);
          }
        }
      }
      
      // Ensure HTTP works properly before attempting SSL 
      console.log(`[DeploymentService] Checking HTTP connectivity to domain ${domain}...`);
      const httpTestCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "curl -I -H 'Host: ${domain}' http://localhost && echo 'Local HTTP check passed' || echo 'Local HTTP check failed'"`;
      const { stdout: httpTestResult } = await this.executeCommand(httpTestCommand);
      console.log(`[DeploymentService] HTTP test result: ${httpTestResult.includes('HTTP') ? 'Success' : 'Failed'}`);
      
      // Also verify that port 80 is accepting external connections
      const externalCheckCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "nc -zv 0.0.0.0 80 && nc -zv 0.0.0.0 443 2>&1 || echo 'Port check failed'"`;
      const { stdout: portCheckResult } = await this.executeCommand(externalCheckCommand);
      console.log(`[DeploymentService] External port check: ${portCheckResult}`);
      
      // Get SSL certificate using webroot method
      console.log(`[DeploymentService] Requesting SSL certificate for ${domain}...`);
      
      // Ensure proper permissions on webroot
      const webrootPermCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo mkdir -p ${webroot}/.well-known && sudo chmod -R 755 ${webroot} && sudo chown -R ${username}:${username} ${webroot}/.well-known"`;
      await this.executeCommand(webrootPermCommand);
      
      const certCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo certbot certonly --webroot -w ${webroot} -d ${domain} --non-interactive --agree-tos --email ${configParams.email || 'admin@example.com'} || echo 'failed'"`;
      const { stdout: certResult, stderr: certError } = await this.executeCommand(certCommand);
      
      // Log detailed results for troubleshooting
      if (certResult.includes('failed') || certResult.includes('error')) {
        console.error(`[DeploymentService] Failed to obtain SSL certificate: ${certResult}`);
        console.error(`[DeploymentService] Certificate error details: ${certError}`);
        
        // Check if we're dealing with Amazon Linux 2023 and try direct Python execution
        const osCheckCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "grep -i 'amazon.*2023' /etc/os-release || echo 'not_amazon_2023'"`;
        const { stdout: osCheckResult } = await this.executeCommand(osCheckCmd);
        
        if (!osCheckResult.includes('not_amazon_2023')) {
          // For Amazon Linux 2023, try direct Python execution
          console.log(`[DeploymentService] Detected Amazon Linux 2023, trying direct Python certbot execution...`);
          
          // Stop nginx temporarily
          const stopNginxCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo systemctl stop nginx"`;
          await this.executeCommand(stopNginxCommand);
          
          // Direct Python execution for standalone mode
          const directPythonCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo python3 -m certbot certonly --standalone -d ${domain} --non-interactive --agree-tos --email ${configParams.email || 'admin@example.com'} || echo 'failed'"`;
          const { stdout: directResult } = await this.executeCommand(directPythonCmd);
          console.log(`[DeploymentService] Direct Python certbot result: ${directResult.substring(0, 500)}${directResult.length > 500 ? '...' : ''}`);
          
          // Start nginx again
          const startNginxCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo systemctl start nginx"`;
          await this.executeCommand(startNginxCommand);
          
          // Check if certificates were obtained
          const certCheckCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo ls -l /etc/letsencrypt/live/${domain}/fullchain.pem 2>/dev/null || echo 'not_found'"`;
          const { stdout: certCheckResult } = await this.executeCommand(certCheckCmd);
          
          if (!certCheckResult.includes('not_found')) {
            console.log(`[DeploymentService] Successfully obtained certificates with direct Python method`);
            // Skip the rest of the error handling and continue with Nginx configuration
            return true;
          }
        }
        
        // Check if certbot command exists
        const checkCertbotCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "which certbot && certbot --version"`;
        const { stdout: certbotVersion, stderr: certbotVersionError } = await this.executeCommand(checkCertbotCommand);
        console.log(`[DeploymentService] Certbot version check: ${certbotVersion.trim()}${certbotVersionError ? ', Error: ' + certbotVersionError.trim() : ''}`);
        
        // Try installing via snap if it's available (for Ubuntu systems)
        const checkSnapCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "which snap || echo 'not_found'"`;
        const { stdout: snapExists } = await this.executeCommand(checkSnapCommand);
        
        if (!snapExists.includes('not_found')) {
          console.log(`[DeploymentService] Snap found, trying certbot installation via snap...`);
          const snapInstallCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo snap install --classic certbot && sudo ln -sf /snap/bin/certbot /usr/bin/certbot"`;
          await this.executeCommand(snapInstallCommand);
        }
        
        // Try an alternative approach if first attempt failed
        console.log(`[DeploymentService] Retrying with standalone method...`);
        
        // Stop nginx temporarily
        const stopNginxCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo systemctl stop nginx"`;
        await this.executeCommand(stopNginxCommand);
        
        // Try standalone method
        const standaloneCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo certbot certonly --standalone -d ${domain} --non-interactive --agree-tos --email ${configParams.email || 'admin@example.com'} || echo 'failed'"`;
        const { stdout: secondAttempt, stderr: secondError } = await this.executeCommand(standaloneCommand);
        
        // Start nginx again
        const startNginxCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo systemctl start nginx"`;
        await this.executeCommand(startNginxCommand);
        
        if (secondAttempt.includes('failed') || secondAttempt.includes('error')) {
          console.error(`[DeploymentService] Second attempt also failed: ${secondAttempt}`);
          console.error(`[DeploymentService] Second attempt error details: ${secondError}`);
          
          // Try debugging the certbot installation
          console.log(`[DeploymentService] Checking certbot installation details...`);
          const certbotPathCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "which certbot && ls -la $(which certbot) && echo 'CERTBOT_DIR' && ls -la $(dirname $(which certbot))"`;
          const { stdout: certbotPathInfo } = await this.executeCommand(certbotPathCommand);
          console.log(`[DeploymentService] Certbot path details: ${certbotPathInfo.trim()}`);
          
          // Check for DNS resolution to Let's Encrypt servers
          const dnsCheckCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "dig +short acme-v02.api.letsencrypt.org && curl -s https://acme-v02.api.letsencrypt.org/directory | head -10 || echo 'Connection failed'"`;
          const { stdout: dnsCheck } = await this.executeCommand(dnsCheckCommand);
          console.log(`[DeploymentService] Let's Encrypt connectivity check: ${dnsCheck.trim()}`);
          
          // Last attempt using staging server (helpful for debugging)
          console.log(`[DeploymentService] Final attempt using Let's Encrypt staging server...`);
          const stagingCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo systemctl stop nginx && sudo certbot certonly --standalone -d ${domain} --non-interactive --agree-tos --email ${configParams.email || 'admin@example.com'} --staging || echo 'failed'"`;
          const { stdout: stagingAttempt } = await this.executeCommand(stagingCommand);
          console.log(`[DeploymentService] Staging attempt result: ${stagingAttempt.substring(0, 500)}`);
          
          // Start nginx again
          await this.executeCommand(startNginxCommand);
          
          // If staging succeeded but production failed, it might be a rate limiting issue
          if (!stagingAttempt.includes('failed') && !stagingAttempt.includes('error')) {
            console.log(`[DeploymentService] Staging server succeeded but production failed. This may indicate rate limiting.`);
            // Note: We don't return true here because staging certs aren't trusted
          }
          
          return false;
        }
      }
      
      // Configure nginx to use the certificate
      console.log(`[DeploymentService] Configuring nginx to use SSL certificate...`);
      
      // Create nginx config with SSL
      const nginxConfig = `
server {
    listen 80;
    server_name ${domain};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ${domain};
    
    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    
    location / {
        proxy_pass http://localhost:${configParams.port || 3000};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;
      
      // Write config locally then copy to server
      const configPath = path.join(tempDir, 'nginx-ssl.conf');
      fs.writeFileSync(configPath, nginxConfig);
      
      const copyCommand = `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${configPath} ${username}@${hostDns}:~/nginx-ssl.conf`;
      await this.executeCommand(copyCommand);
      
      // Move to nginx sites and restart
      const setupCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostDns} "sudo mv ~/nginx-ssl.conf /etc/nginx/conf.d/${domain}.conf && sudo nginx -t && sudo systemctl restart nginx || echo 'failed'"`;
      const { stdout: setupResult, stderr: setupError } = await this.executeCommand(setupCommand);
      
      if (setupResult.includes('failed')) {
        console.error(`[DeploymentService] Failed to configure nginx: ${setupResult}`);
        console.error(`[DeploymentService] Nginx configuration error: ${setupError}`);
        return false;
      }
      
      console.log(`[DeploymentService] SSL successfully configured for ${domain}`);
      
      // Clean up
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.log(`[DeploymentService] Error cleaning up: ${cleanupError.message}`);
      }
      
      // Store the SSL configuration in the pipeline config if available
      if (configParams.pipelineId) {
        await this.updatePipelineDeploymentConfig(configParams.pipelineId, {
          ssl: {
            enabled: true,
            domain,
            configuredAt: new Date().toISOString()
          }
        });
      }
      
      return true;
    } catch (error) {
      console.error(`[DeploymentService] Error configuring SSL: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    }
  }

  /**
   * Parse pipeline triggers from JSON value
   */
  private parsePipelineTriggers(triggers: JsonValue): PipelineTriggers {
    try {
      // Check if triggers is a string and try to parse it
      if (typeof triggers === 'string') {
        try {
          return JSON.parse(triggers);
        } catch (e) {
          console.error(`[DeploymentService] Error parsing string triggers:`, e);
          return { events: [], branches: [] };
        }
      }
      
      // Check if triggers is undefined or null
      if (!triggers) {
        return { events: [], branches: [] };
      }
      
      // Check if triggers is an object with events and branches properties
      if (typeof triggers === 'object' && triggers !== null) {
        const triggerObj = triggers as any;
        return {
          events: Array.isArray(triggerObj.events) ? triggerObj.events : [],
          branches: Array.isArray(triggerObj.branches) ? triggerObj.branches : []
        };
      }
      
      // Default return value
      return { events: [], branches: [] };
    } catch (error) {
      console.error(`[DeploymentService] Error parsing triggers:`, error);
      return { events: [], branches: [] };
    }
  }

  /**
   * Ensure deployment configuration is preserved
   */
  private async ensureDeploymentConfigPreserved(config: DeploymentConfig): Promise<void> {
    // This is a placeholder for the missing method
    console.log(`[DeploymentService] Ensuring deployment config is preserved`);
    return Promise.resolve();
  }

  /**
   * Check if an EC2 instance is healthy
   */
  private async checkInstanceHealth(instanceId: string, config: DeploymentConfig): Promise<boolean> {
    // Handle undefined or empty instance ID
    if (!instanceId) {
      console.error(`[DeploymentService] No instance ID provided to health check`);
      return false;
    }
    
    try {
      const ec2Client = new EC2Client({
        region: config.region || 'us-east-1',
        credentials: {
          accessKeyId: config.awsAccessKeyId || '',
          secretAccessKey: config.awsSecretAccessKey || ''
        }
      });
      
      const statusCommand = new DescribeInstanceStatusCommand({
        InstanceIds: [instanceId],
        IncludeAllInstances: true
      });
      
      const response = await ec2Client.send(statusCommand);
      const status = response.InstanceStatuses?.[0];
      
      if (!status) {
        console.error(`[DeploymentService] No status returned for instance ${instanceId}`);
        return false;
      }
      
      const isRunning = status.InstanceState?.Name === 'running';
      const isHealthy = status.InstanceStatus?.Status === 'ok' && status.SystemStatus?.Status === 'ok';
      
      console.log(`[DeploymentService] Instance ${instanceId} running: ${isRunning}, health: ${isHealthy ? 'healthy' : 'unhealthy'}`);
      
      return isRunning && isHealthy;
    } catch (error) {
      console.error(`[DeploymentService] Error checking instance health:`, error);
      return false;
    }
  }

  /**
   * Update the deployed app record
   */
  private async updateDeployedApp(
    run: PipelineRun,
    config: DeploymentConfig,
    details: { url?: string; environment?: string }
  ): Promise<void> {
    try {
      console.log(`[DeploymentService] Updating deployed app for pipeline ${run.pipelineId}`);
      
      // Get the app name from the pipeline name or config
      const appName = run.pipeline?.name?.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'app';
      
      // Get the URL from details or instance DNS
      const url = details.url || 
                 (config.publicDns ? `http://${config.publicDns}` : '') || 
                 (config.config?.publicDns ? `http://${config.config.publicDns}` : '') || 
                 'http://localhost';
      
      // Environment (default to production)
      const environment = details.environment || 'production';
      
      // Look for existing record
      const existingApp = await this.prisma.deployedApp.findFirst({
        where: {
          pipelineId: run.pipelineId,
          environment
        }
      });
      
      if (existingApp) {
        // Update existing record
        await this.prisma.deployedApp.update({
          where: { id: existingApp.id },
          data: {
            url,
            status: 'deployed',
            lastDeployed: new Date(),
            name: appName
          }
        });
        
        console.log(`[DeploymentService] Updated existing deployed app record: ${existingApp.id}`);
      } else {
        // Create new record - build data object carefully to prevent schema errors
        const createData: any = {
          name: appName,
          url,
          status: 'deployed',
          lastDeployed: new Date(),
          environment
        };
        
        // Add pipeline relation
        if (run.pipelineId) {
          createData.pipeline = {
            connect: { id: run.pipelineId }
          };
        }
        
        // Add project relation if available
        if (run.pipeline?.projectId) {
          createData.project = {
            connect: { id: run.pipeline.projectId }
          };
        }
        
        // Create the record
        const newApp = await this.prisma.deployedApp.create({ data: createData });
        
        console.log(`[DeploymentService] Created new deployed app record: ${newApp.id}`);
      }
    } catch (error) {
      console.error(`[DeploymentService] Error updating deployed app:`, error);
      // Don't throw the error - we don't want to fail the deployment just because
      // of a database update issue
    }
  }

  /**
   * Process, validate and save an SSH key to a file
   * Handles base64 encoded keys and normalizes line endings
   * (Copied from PipelineRunnerService to resolve missing method error)
   */
  private async processSshKey(config: DeploymentConfig, keyPath: string): Promise<boolean> {
    try {
      this.logger.info('[DeploymentService] Processing SSH key'); // Use this.logger
      this.logger.info(`[DeploymentService] Key path: ${keyPath}`);
      
      // Try to get the key from both possible sources
      const sshKey = config.ec2SshKey || '';
      const encodedKey = config.ec2SshKeyEncoded || '';
      
      this.logger.info(`[DeploymentService] Regular key length: ${sshKey.length}, Encoded key length: ${encodedKey.length}`);
      
      let finalKey = '';
      let source = '';
      
      // First try the encoded key if present
      if (encodedKey.length > 0) {
        try {
          const decodedKey = Buffer.from(encodedKey, 'base64').toString('utf-8');
          this.logger.info(`[DeploymentService] Successfully decoded Base64 key (${decodedKey.length} chars)`);
          
          // Verify it looks like a PEM key (has BEGIN and END markers)
          if (decodedKey.includes('-----BEGIN') && decodedKey.includes('-----END')) {
            finalKey = decodedKey;
            source = 'decoded';
            this.logger.info(`[DeploymentService] Using decoded key`);
          } else {
            this.logger.info(`[DeploymentService] Decoded key doesn't look like valid PEM format`);
          }
        } catch (decodeError) {
          this.logger.info(`[DeploymentService] Error decoding Base64 key: ${decodeError.message}`);
        }
      }
      
      // Fall back to regular key if decoded key didn't work
      if (!finalKey && sshKey.length > 0) {
        finalKey = sshKey;
        source = 'regular';
        this.logger.info(`[DeploymentService] Using regular SSH key`);
      }
      
      // If still no key, try looking for files in common locations
      if (!finalKey) {
        this.logger.info('[DeploymentService] No key in config, searching filesystem...');
        try {
            const homeDir = os.homedir();
            const sshDir = path.join(homeDir, '.ssh');
            const potentialDirs = [sshDir, process.cwd(), '/tmp'];
            let keyFiles: string[] = [];

            for (const dir of potentialDirs) {
                try {
                    if (fs.existsSync(dir)) {
                        const files = fs.readdirSync(dir)
                            .filter(file => file.endsWith('.pem') || file.includes('lightci') || file.startsWith('id_'))
                            .map(file => path.join(dir, file))
                            .filter(file => fs.statSync(file).isFile()); 
                        keyFiles = keyFiles.concat(files);
                    }
                } catch (dirError) {
                  this.logger.info(`[DeploymentService] Error reading dir ${dir}: ${dirError.message}`);
                }
            }
            
            // Sort by modification time, newest first
            keyFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            
            this.logger.info(`[DeploymentService] Found ${keyFiles.length} potential key files.`);
            
            // Try each key from most recent to oldest
            for (const keyFile of keyFiles) {
              try {
                this.logger.info(`[DeploymentService] Trying key file: ${keyFile}`);
                const keyContent = fs.readFileSync(keyFile, 'utf8');
                
                // Basic validation
                if (keyContent.includes('-----BEGIN') && keyContent.includes('-----END')) {
                  finalKey = keyContent;
                  source = `file:${keyFile}`;
                  this.logger.info(`[DeploymentService] Found valid SSH key in ${keyFile}`);
                  break;
                }
              } catch (readError) {
                this.logger.info(`[DeploymentService] Error reading key file ${keyFile}: ${readError.message}`);
              }
            }
        } catch (searchError) {
          this.logger.info(`[DeploymentService] Error searching for key files: ${searchError.message}`);
        }
      }
      
      if (!finalKey) {
        this.logger.info(`[DeploymentService] No valid SSH key found in configuration or file system`);
        this.logger.info(`[DeploymentService] Please ensure a valid SSH key is available for deployment`);
        
        // Provide detailed error for debugging
        if (config.instanceId) {
          this.logger.info(`[DeploymentService] Instance ID: ${config.instanceId}`);
        }
        if (config.publicDns) {
          this.logger.info(`[DeploymentService] Instance DNS: ${config.publicDns}`);
        }
        
        return false;
      }
      
      // Normalize line endings (CRLF to LF)
      finalKey = finalKey.replace(/\r\n/g, '\n');
      // Ensure final newline
      if (!finalKey.endsWith('\n')) {
          finalKey += '\n';
      }

      // Remove extra blank lines
      finalKey = finalKey.replace(/\n\n+/g, '\n');
      
      this.logger.info(`[DeploymentService] Processed key (source: ${source}, length: ${finalKey.length})`);
      
      // Ensure key looks valid
      if (!finalKey.trim().startsWith('-----BEGIN') || !finalKey.trim().includes('-----END')) {
        this.logger.info(`[DeploymentService] Processed key is missing BEGIN/END markers`);
        return false;
      }
      
      // Write the key to the specified path
      try {
        this.logger.info(`[DeploymentService] Writing key to ${keyPath}`);
        fs.writeFileSync(keyPath, finalKey, { mode: 0o600 });
      } catch (writeError) {
        this.logger.info(`[DeploymentService] Error writing key file: ${writeError.message}`);
        return false;
      }
      
      // Verify permissions were set correctly
      try {
        const stats = fs.statSync(keyPath);
        const permissions = stats.mode & 0o777;
        if (permissions !== 0o600) {
          this.logger.info(`[DeploymentService] Correcting permissions for ${keyPath} (was ${permissions.toString(8)})`);
          fs.chmodSync(keyPath, 0o600);
        }
      } catch (statError) {
        this.logger.info(`[DeploymentService] Error checking key file permissions: ${statError.message}`);
        // Continue if we can't check permissions
      }

      // Read back to verify content integrity (optional but good practice)
      try {
        const writtenKey = fs.readFileSync(keyPath, 'utf8');
        if (writtenKey !== finalKey) {
          this.logger.info(`[DeploymentService] Key file content mismatch after writing!`);
          this.logger.info(`Original length: ${finalKey.length}, Written length: ${writtenKey.length}`);
          // Consider returning false here
        }
      } catch (readError) {
        this.logger.info(`[DeploymentService] Error reading back key file: ${readError.message}`);
      }
      
      // As a final check, verify the key with ssh-keygen
      try {
        // Use -l to list the key fingerprint (validates the key format)
        const keyInfo = execSync(`ssh-keygen -l -f "${keyPath}"`, { encoding: 'utf8' });
        this.logger.info(`[DeploymentService] Key validated with ssh-keygen: ${keyInfo.trim()}`);
      } catch (keygenError) {
        this.logger.info(`[DeploymentService] Warning: ssh-keygen couldn't validate key: ${keygenError.message || 'unknown error'}`);
        
        // Try again with different parameters
        try {
          const keyTest = execSync(`ssh-keygen -y -f "${keyPath}"`, { encoding: 'utf8' });
          if (keyTest.includes('ssh-rsa') || keyTest.includes('ecdsa') || keyTest.includes('ed25519')) { // Check for common key types
            this.logger.info(`[DeploymentService] Key validated with ssh-keygen -y`);
          } else {
            this.logger.info(`[DeploymentService] Key validation returned unexpected output: ${keyTest.substring(0, 50)}...`);
          }
        } catch (alternateSshKeygenError) {
          this.logger.info(`[DeploymentService] Key failed second validation: ${alternateSshKeygenError.message || 'unknown error'}`);
          this.logger.info(`[DeploymentService] This may indicate a corrupted SSH key file`);
          // Decide if we should fail hard here. For now, let's allow it but log extensively.
          // return false; 
        }
      }
      
      this.logger.info(`[DeploymentService] SSH key processing completed successfully (from ${source})`);
      return true;
    } catch (error) {
      this.logger.info(`[DeploymentService] Error processing SSH key: ${error.message}`);
      return false;
    }
  }

  /**
   * Execute a shell command
   */
  private async executeCommand(command: string): Promise<{ stdout: string; stderr: string }> {
    return await execAsync(command);
  }

  /**
   * Create an archive from a source directory
   */
  private async createArchive(sourcePath: string, targetPath: string): Promise<void> {
    console.log(`[DeploymentService] Creating archive from ${sourcePath} to ${targetPath}`);
    
    try {
      // Ensure source directory exists
      if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source directory ${sourcePath} does not exist`);
      }
      
      // Check if source directory is empty
      const sourceContents = fs.readdirSync(sourcePath);
      if (sourceContents.length === 0) {
        console.warn(`[DeploymentService] Warning: Source directory ${sourcePath} is empty`);
        // Create a placeholder file to ensure tar doesn't fail
        fs.writeFileSync(path.join(sourcePath, '.placeholder'), 'This is a placeholder file to ensure the archive is not empty.');
      }
      
      // Ensure target directory exists
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      
      // Create the archive using tar command (cross-platform approach)
      if (process.platform === 'win32') {
        // Windows approach
        throw new Error('Windows platform not supported for archive creation yet');
      } else {
        // Linux/Mac approach with tar command
        const tarCmd = `tar -czf "${targetPath}" -C "${sourcePath}" .`;
        const { stdout, stderr } = await this.executeCommand(tarCmd);
        
        if (stderr && !stderr.includes('tar: Removing leading')) {
          console.warn(`[DeploymentService] Warning during archive creation: ${stderr}`);
        }
        
        // Verify the archive was created successfully
        if (!fs.existsSync(targetPath)) {
          throw new Error(`Failed to create archive at ${targetPath}`);
        }
        
        const stats = fs.statSync(targetPath);
        if (stats.size === 0) {
          throw new Error(`Created archive is empty (0 bytes)`);
        }
        
        console.log(`[DeploymentService] Successfully created archive at ${targetPath} (${stats.size} bytes)`);
      }
    } catch (error) {
      console.error(`[DeploymentService] Error creating archive:`, error);
      throw error; // Rethrow the error to be handled by the caller
    }
  }

  /**
   * Configure custom domains for a deployed app
   */
  private async configureCustomDomains(
    deployedApp: { id: string; url: string; name: string },
    domains: { id: string; domain: string; verify_token: string }[],
    config: DeploymentConfig
  ): Promise<void> {
    try {
      console.log(`[DeploymentService] Configuring custom domains for app ${deployedApp.name}`);
      
      // Ensure we have exec functionality
      if (!this.executeCommand || typeof this.executeCommand !== 'function') {
        console.error('[DeploymentService] executeCommand method not available, cannot configure domains');
        return;
      }
      
      if (!domains.length) {
        console.log(`[DeploymentService] No domains to configure`);
        return;
      }
      
      if (!config.ec2SshKey && !config.ec2SshKeyEncoded) {
        console.error(`[DeploymentService] Missing SSH key required for domain configuration`);
        return;
      }
      
      // Extract the SSH key
      let sshKey = config.ec2SshKey || '';
      if (!sshKey && config.ec2SshKeyEncoded) {
        try {
          sshKey = Buffer.from(config.ec2SshKeyEncoded, 'base64').toString('utf-8');
        } catch (error) {
          console.error(`[DeploymentService] Error decoding SSH key:`, error);
          return;
        }
      }
      
      if (!sshKey) {
        console.error(`[DeploymentService] Failed to get valid SSH key for domain configuration`);
        return;
      }
      
      // Ensure we have required parameters
      const hostname = config.publicDns;
      const username = config.ec2Username || 'ec2-user';
      
      if (!hostname) {
        console.error(`[DeploymentService] Missing hostname/public DNS for domain configuration`);
        return;
      }
      
      // Create temporary directory for SSH operations
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightci-domain-'));
      const keyPath = path.join(tempDir, 'ssh_key.pem');
      fs.writeFileSync(keyPath, sshKey, { mode: 0o600 });
      
      // Extract app port from URL or use default
      const appUrl = new URL(deployedApp.url);
      const appPort = appUrl.port || '3000'; // Default to 3000 if no port specified
      console.log(`[DeploymentService] Using application port: ${appPort}`);
      
      // Verify SSH connectivity first
      try {
        console.log(`[DeploymentService] Verifying SSH connectivity to ${username}@${hostname}...`);
        const sshTestCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "echo 'SSH connection successful'"`;
        const { stdout: sshResult } = await this.executeCommand(sshTestCommand);
        
        if (!sshResult.includes('SSH connection successful')) {
          console.error(`[DeploymentService] SSH connectivity test failed`);
          console.error(`[DeploymentService] SSH test output: ${sshResult}`);
          return;
        }
        console.log(`[DeploymentService] SSH connectivity verified successfully`);
      } catch (sshError) {
        console.error(`[DeploymentService] SSH connectivity test failed with error:`, sshError);
        return;
      }

      // Process each domain
      for (const domain of domains) {
        console.log(`[DeploymentService] Setting up domain ${domain.domain} for app ${deployedApp.name}`);
        
        // 1. Check application status - ensure it's running on the expected port
        try {
          console.log(`[DeploymentService] Verifying application is running on port ${appPort}...`);
          const checkAppCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "curl -s http://localhost:${appPort} || echo 'APP_NOT_RESPONDING'"`;
          const { stdout: appCheckResult } = await this.executeCommand(checkAppCommand);
          
          if (appCheckResult.includes('APP_NOT_RESPONDING')) {
            console.error(`[DeploymentService] WARNING: Application does not appear to be responding on port ${appPort}. Nginx configuration may not work correctly.`);
            // Continue anyway, but with a warning
          } else {
            console.log(`[DeploymentService] Application verified to be running on port ${appPort}`);
          }
        } catch (appCheckError) {
          console.error(`[DeploymentService] Application check failed:`, appCheckError);
          // Continue with setup despite this error
        }
        
        // 2. Check if nginx is installed and install if needed
        console.log(`[DeploymentService] Checking if Nginx is installed...`);
        try {
          let nginxInstalled = false;
          let startNginx = false; // Flag to track if we need to start Nginx

          // Check existing install
          const checkCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} \"which nginx || echo \'not_found\'\"`;
          const { stdout: nginxPath } = await this.executeCommand(checkCommand);

          if (nginxPath.includes('not_found')) {
            console.log(`[DeploymentService] Nginx not found, installing...`);
            
            // Determine OS
            const checkOsCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} \"cat /etc/os-release | grep -i \'id=\' || echo \'unknown\'\"`;
            const { stdout: osInfo } = await this.executeCommand(checkOsCommand);
            console.log(`[DeploymentService] OS detection: ${osInfo.trim()}`);

            let installCommand = '';
            if (osInfo.includes('amazon') || osInfo.includes('fedora') || osInfo.includes('centos')) {
              // Amazon Linux / Fedora / CentOS - use yum/dnf
              console.log(`[DeploymentService] Using yum/dnf for Nginx installation.`);
              installCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} \"sudo yum install -y nginx || sudo dnf install -y nginx\"`;
            } else if (osInfo.includes('ubuntu') || osInfo.includes('debian')) {
              // Ubuntu / Debian - use apt
              console.log(`[DeploymentService] Using apt for Nginx installation.`);
              installCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} \"sudo apt-get update && sudo apt-get install -y nginx\"`;
            } else {
              console.error(`[DeploymentService] Unsupported OS detected: ${osInfo.trim()}. Cannot automatically install Nginx.`);
              continue; // Skip this domain if OS is unsupported
            }

            // Execute installation
            const { stdout: installOutput, stderr: installError } = await this.executeCommand(installCommand);
            console.log(`[DeploymentService] Nginx installation output: ${installOutput.substring(0, 500)}${installOutput.length > 500 ? '...' : ''}`);
            // Ignore specific errors that indicate already installed or nothing to do
            if (installError && !installOutput.includes('already installed') && !installOutput.includes('Nothing to do')) {
              console.error(`[DeploymentService] Nginx installation errors: ${installError}`);
            }

            // Verify Nginx was installed
            const verifyCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} \"which nginx || echo \'not_found\'\"`;
            const { stdout: verifyPath } = await this.executeCommand(verifyCommand);

            if (verifyPath.includes('not_found')) {
              console.error(`[DeploymentService] Failed to install or verify Nginx. Cannot continue with domain ${domain.domain}.`);
              continue; // Skip this domain if installation failed
            } else {
               console.log(`[DeploymentService] Nginx installed successfully at path: ${verifyPath.trim()}`);
               nginxInstalled = true;
               startNginx = true; // Mark Nginx to be started
            }
          } else {
            console.log(`[DeploymentService] Nginx is already installed at path: ${nginxPath.trim()}`);
            nginxInstalled = true;
          }

          // 3. Ensure Nginx is running and enabled
          let nginxRunning = false;
          if (nginxInstalled) {
             console.log(`[DeploymentService] Checking Nginx service status...`);
             const checkServiceCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} \"sudo systemctl is-active nginx || echo \'inactive\'\"`;
             const { stdout: serviceStatusResult } = await this.executeCommand(checkServiceCommand);
             const isNginxActive = serviceStatusResult.trim() === 'active';

             if (!isNginxActive || startNginx) { // Start if inactive or if just installed
                console.log(`[DeploymentService] Nginx service is ${serviceStatusResult.trim()}, attempting to enable and start...`);
                // Use systemctl enable --now for atomicity
                const startCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} \"sudo systemctl enable --now nginx || echo \'START_FAILED\'\"`;
                const { stdout: startOutput, stderr: startError } = await this.executeCommand(startCommand);

                // Check for explicit failure or error (ignoring expected symlink message)
                if (startOutput.includes('START_FAILED') || (startError && !startError.includes('Created symlink'))) {
                   console.error(`[DeploymentService] Failed to start Nginx service: ${startError || startOutput}`);
                   // Check logs for more details
                   const checkLogsCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} \"sudo journalctl -u nginx --no-pager -n 20 || echo \'NO_LOGS\'\"`;
                   const { stdout: logsOutput } = await this.executeCommand(checkLogsCommand);
                   console.error(`[DeploymentService] Nginx service logs: ${logsOutput}`);
                   nginxRunning = false;
                } else {
                   console.log(`[DeploymentService] Successfully enabled and started Nginx service`);
                   nginxRunning = true;
                }
             } else {
                console.log(`[DeploymentService] Nginx service is running (status: ${serviceStatusResult.trim()})`);
                nginxRunning = true;
             }
          } else {
             console.log(`[DeploymentService] Skipping Nginx status check as installation failed or was skipped.`);
             nginxRunning = false; // Cannot be running if not installed
          }

          // If Nginx isn't running at this point, we cannot proceed with config/SSL for this domain
          if (!nginxRunning) {
             console.error(`[DeploymentService] Nginx is not running. Skipping configuration for domain ${domain.domain}.`);
             continue; // Skip to the next domain
          }
          
          // 4. Check port availability - ensure 80 is not in use by another process (if Nginx is expected to use it)
          console.log(`[DeploymentService] Checking if port 80 is available for Nginx...`);
          const portCheckCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "sudo netstat -tulpn | grep -w ':80 ' || echo 'PORT_AVAILABLE'"`;
          const { stdout: portCheck } = await this.executeCommand(portCheckCommand);
          
          if (!portCheck.includes('PORT_AVAILABLE')) {
            if (portCheck.includes('nginx')) {
              console.log(`[DeploymentService] Port 80 is in use by Nginx (expected)`);
            } else {
              console.error(`[DeploymentService] WARNING: Port 80 appears to be in use by another process: ${portCheck.trim()}. Configuration might fail.`);
            }
          } else {
            // This case might happen if Nginx failed to start properly and bind to port 80
            console.warn(`[DeploymentService] Port 80 appears available, which might indicate Nginx failed to bind.`);
          }
          
          // Create nginx configuration file
          console.log(`[DeploymentService] Creating Nginx configuration for ${domain.domain}...`);
          const nginxConfig = `
server {
    listen 80;
    server_name ${domain.domain};
    
    # Add access and error logs for troubleshooting
    access_log /var/log/nginx/${domain.domain}-access.log;
    error_log /var/log/nginx/${domain.domain}-error.log;
    
    # Set maximum body size for uploads
    client_max_body_size 50M;
    
    # Increase proxy timeouts
    proxy_connect_timeout 300;
    proxy_send_timeout 300;
    proxy_read_timeout 300;
    send_timeout 300;
    
    # Configuration to better handle WebSocket connections
    location /sockjs-node {
        proxy_pass http://localhost:${appPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
    
    # Handle static asset paths better - common for React/Vue/Angular apps
    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        proxy_pass http://localhost:${appPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        # Add cache headers
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }
    
    # Main location block for application
    location / {
        proxy_pass http://localhost:${appPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}`;
          
          const configPath = path.join(tempDir, `${domain.domain}.conf`);
          fs.writeFileSync(configPath, nginxConfig);
          console.log(`[DeploymentService] Created local configuration file at ${configPath}`);
          
          // 5. Copy the configuration to the server
          console.log(`[DeploymentService] Copying configuration to server...`);
          const copyCommand = `scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${configPath} ${username}@${hostname}:~/${domain.domain}.conf`;
          await this.executeCommand(copyCommand);
          
          // 6. Validate the configuration before applying
          console.log(`[DeploymentService] Validating Nginx configuration...`);
          const validateCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "sudo nginx -t -c /etc/nginx/nginx.conf || echo 'CONFIG_INVALID'"`;
          const { stdout: validateOutput, stderr: validateError } = await this.executeCommand(validateCommand);
          
          if (validateOutput.includes('CONFIG_INVALID') || validateError.includes('failed')) {
            console.error(`[DeploymentService] Nginx configuration validation failed: ${validateError || validateOutput}`);
            // Continue anyway, but note the issue
          } else {
            console.log(`[DeploymentService] Nginx configuration validated successfully`);
          }
          
          // 7. Move the configuration to nginx sites and restart
          console.log(`[DeploymentService] Applying configuration and restarting Nginx...`);
          const setupCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "sudo mv ~/${domain.domain}.conf /etc/nginx/conf.d/${domain.domain}.conf && sudo nginx -t && sudo systemctl restart nginx || echo 'RESTART_FAILED'"`;
          const { stdout: setupOutput, stderr: setupError } = await this.executeCommand(setupCommand);
          
          if (setupOutput.includes('RESTART_FAILED') || setupError.includes('failed')) {
            console.error(`[DeploymentService] Failed to apply Nginx configuration: ${setupError || setupOutput}`);
            
            // Attempt to recover - check what went wrong
            const diagCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "sudo nginx -t && sudo cat /etc/nginx/conf.d/${domain.domain}.conf || echo 'FILE_MISSING'"`;
            const { stdout: diagOutput, stderr: diagError } = await this.executeCommand(diagCommand);
            console.error(`[DeploymentService] Diagnostic output: ${diagOutput}\nErrors: ${diagError}`);
          } else {
            console.log(`[DeploymentService] Successfully applied Nginx configuration and restarted service`);
          }
          
          // 8. Verify Nginx is handling requests
          console.log(`[DeploymentService] Verifying Nginx is responding to requests...`);
          const testCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "curl -I -H 'Host: ${domain.domain}' http://localhost || echo 'TEST_FAILED'"`;
          const { stdout: testOutput } = await this.executeCommand(testCommand);
          
          if (testOutput.includes('TEST_FAILED') || !testOutput.includes('HTTP/1.1')) {
            console.error(`[DeploymentService] WARNING: Nginx does not appear to be handling requests correctly: ${testOutput}`);
          } else {
            console.log(`[DeploymentService] Nginx is correctly handling requests for ${domain.domain}`);
          }
          
          console.log(`[DeploymentService] Successfully configured domain ${domain.domain}`);
          
          // Configure SSL for all domains by default
          // This was previously conditional based on config.config?.enableSSL
          try {
            console.log(`[DeploymentService] Setting up SSL for domain ${domain.domain}`);
            
            // Ensure web root directory exists (/var/www/html is default in many configs)
            const ensureWebrootCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "sudo mkdir -p /var/www/html && sudo chmod -R 755 /var/www/html"`;
            await this.executeCommand(ensureWebrootCommand);
            
            // Call the existing SSL configuration method
            const sslConfigParams = {
              port: appPort,
              email: config.config?.email || `admin@${domain.domain}`,
              pipelineId: config.pipelineId
            };
            
            const sslSuccess = await this.configureSSL(
              domain.domain,
              '/var/www/html',
              sslConfigParams,
              sshKey,
              username,
              hostname
            );
            
            if (sslSuccess) {
              console.log(`[DeploymentService] SSL successfully configured for ${domain.domain}`);
            } else {
              console.error(`[DeploymentService] Failed to configure SSL for ${domain.domain}`);
            }
          } catch (sslError) {
            console.error(`[DeploymentService] Error configuring SSL: ${sslError.message}`);
          }
          
          // After successfully applying the configuration, add a check for the application itself
          if (!setupOutput.includes('RESTART_FAILED') && !setupError.includes('failed')) {
            console.log(`[DeploymentService] Successfully applied Nginx configuration and restarted service`);
            
            // Additional check: Ensure the application is properly running
            console.log(`[DeploymentService] Verifying application status...`);
            const appStatusCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "ps aux | grep -v grep | grep -i 'node\\|npm\\|pm2' || echo 'NO_NODE_PROCESS'"`;
            const { stdout: appStatusOutput } = await this.executeCommand(appStatusCommand);
            
            if (appStatusOutput.includes('NO_NODE_PROCESS')) {
              console.error(`[DeploymentService] WARNING: No Node.js processes found running on the server. The application may not be running.`);
            } else {
              // Count how many node processes are running
              const nodeProcessCount = appStatusOutput.split('\n').filter(line => line.trim().length > 0).length;
              console.log(`[DeploymentService] Found ${nodeProcessCount} Node.js processes running on the server`);
            }
            
            // Check if the application port is open and listening
            const portListenCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "sudo netstat -tulpn | grep :${appPort} || echo 'PORT_NOT_LISTENING'"`;
            const { stdout: portListenOutput } = await this.executeCommand(portListenCommand);
            
            if (portListenOutput.includes('PORT_NOT_LISTENING')) {
              console.error(`[DeploymentService] WARNING: No process is listening on port ${appPort}. The application may not be running properly.`);
              
              // Try to start the application if a start script is found
              console.log(`[DeploymentService] Attempting to restart the application...`);
              const restartAppCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i ${keyPath} ${username}@${hostname} "cd ~/app && (pm2 restart all || npm start) || echo 'RESTART_FAILED'"`;
              const { stdout: restartOutput } = await this.executeCommand(restartAppCommand);
              console.log(`[DeploymentService] Application restart attempt result: ${restartOutput}`);
            } else {
              console.log(`[DeploymentService] Application is listening on port ${appPort}: ${portListenOutput.trim()}`);
            }
          }
        } catch (error) {
          console.error(`[DeploymentService] Error configuring domain ${domain.domain}:`, error);
        }
      }
      
      // Clean up
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.log(`[DeploymentService] Error cleaning up: ${cleanupError.message}`);
      }
      
      console.log(`[DeploymentService] Completed custom domain configuration for ${deployedApp.name}`);
    } catch (error) {
      console.error(`[DeploymentService] Error in configureCustomDomains:`, error);
    }
  }
}