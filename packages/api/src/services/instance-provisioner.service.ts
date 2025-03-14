import { PrismaClient } from '@prisma/client';
import { EC2Client, RunInstancesCommand, DescribeInstancesCommand, _InstanceType, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { BillingService } from './billing.service.js';
import { execAsync } from '../utils/execAsync.js';

export interface InstanceConfig {
  region: string;
  imageId: string;
  keyName: string;
  securityGroupIds: string[];
  subnetId: string;
  userData?: string;
}

export class InstanceProvisionerService {
  private ec2Client: EC2Client;
  private billingService: BillingService;

  constructor(
    private prisma: PrismaClient,
    private config: InstanceConfig,
    awsAccessKeyId: string,
    awsSecretAccessKey: string
  ) {
    this.ec2Client = new EC2Client({
      region: config.region,
      credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey
      }
    });
    this.billingService = new BillingService(prisma);
  }

  /**
   * Get the appropriate instance type based on user's account tier
   */
  private getInstanceTypeForTier(tier: string): _InstanceType {
    switch (tier.toLowerCase()) {
      case 'free':
        throw new Error('Free tier does not support EC2 instances');
      case 'basic':
        return _InstanceType.t2_micro; // Small instance for basic tier
      case 'professional':
      case 'enterprise':
        return _InstanceType.t2_medium; // Medium instance for higher tiers
      default:
        return _InstanceType.t2_micro; // Default to small instance
    }
  }

  /**
   * Provision a new EC2 instance based on user's tier
   */
  async provisionInstance(userId: string, pipelineId?: string): Promise<{ instanceId: string; publicDns?: string }> {
    // Get user's account tier
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { accountTier: true }
    });

    if (!user) {
      throw new Error('User not found');
    }

    // If pipelineId is provided, check for existing instance
    if (pipelineId) {
      const existingDeployment = await this.prisma.autoDeployment.findFirst({
        where: {
          pipelineId,
          status: 'active'
        }
      });

      if (existingDeployment) {
        // Verify the instance is still running
        try {
          const command = new DescribeInstancesCommand({
            InstanceIds: [existingDeployment.instanceId]
          });
          const result = await this.ec2Client.send(command);
          const instance = result.Reservations?.[0]?.Instances?.[0];

          if (instance?.State?.Name === 'running') {
            console.log(`[InstanceProvisionerService] Reusing existing instance ${existingDeployment.instanceId} for pipeline ${pipelineId}`);
            return {
              instanceId: existingDeployment.instanceId,
              publicDns: instance.PublicDnsName
            };
          }
        } catch (error) {
          console.error(`[InstanceProvisionerService] Error checking existing instance:`, error);
          // Instance might not exist anymore, continue with provisioning new one
        }
      }
    }

    // Check if user has reached their instance limit
    const userInstances = await this.prisma.autoDeployment.count({
      where: {
        userId,
        status: 'active'
      }
    });

    const instanceLimits: Record<string, number> = {
      'free': 0,
      'basic': 1,
      'professional': 2,
      'enterprise': 5
    };

    const limit = instanceLimits[user.accountTier.toLowerCase()] || 0;
    if (userInstances >= limit) {
      throw new Error(`Instance limit reached for ${user.accountTier} tier (${limit} instances)`);
    }

    // Get instance type based on tier
    const instanceType = this.getInstanceTypeForTier(user.accountTier);

    try {
      // Launch the EC2 instance
      const command = new RunInstancesCommand({
        ImageId: this.config.imageId,
        InstanceType: instanceType,
        KeyName: this.config.keyName,
        MinCount: 1,
        MaxCount: 1,
        SecurityGroupIds: this.config.securityGroupIds,
        SubnetId: this.config.subnetId,
        UserData: Buffer.from(`#!/bin/bash
# Update system
yum update -y

# Remove any existing nodejs installation
yum remove -y nodejs npm
rm -rf /usr/lib/node_modules
rm -f /usr/bin/node /usr/bin/npm

# Install Node.js from Amazon's package manager
curl --silent --location https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# Verify npm is working and install required npm dependencies
npm install -g semver
npm install -g pm2@latest

# Ensure SSH daemon is running
systemctl enable sshd
systemctl start sshd

# Configure SSH for the ec2-user
mkdir -p /home/ec2-user/.ssh
chmod 700 /home/ec2-user/.ssh
touch /home/ec2-user/.ssh/authorized_keys
chmod 600 /home/ec2-user/.ssh/authorized_keys
chown -R ec2-user:ec2-user /home/ec2-user/.ssh

# Create app directory
mkdir -p /home/ec2-user/app
chown -R ec2-user:ec2-user /home/ec2-user/app
`).toString('base64'),
        TagSpecifications: [
          {
            ResourceType: 'instance',
            Tags: [
              { Key: 'ManagedBy', Value: 'LightCI' },
              { Key: 'UserId', Value: userId },
              { Key: 'Tier', Value: user.accountTier },
              ...(pipelineId ? [{ Key: 'PipelineId', Value: pipelineId }] : [])
            ]
          }
        ]
      });

      console.log('[InstanceProvisionerService] Launching EC2 instance...');
      const result = await this.ec2Client.send(command);
      
      if (!result.Instances || result.Instances.length === 0) {
        throw new Error('No instance information in launch response');
      }

      const instance = result.Instances[0];
      const instanceId = instance.InstanceId;

      if (!instanceId) {
        throw new Error('Failed to get instance ID from launch response');
      }

      console.log(`[InstanceProvisionerService] Instance ${instanceId} launched, waiting for it to be running...`);

      // Wait for the instance to be running and get its public DNS
      const publicDns = await this.waitForInstanceRunning(instanceId);
      console.log(`[InstanceProvisionerService] Instance ${instanceId} is running with DNS ${publicDns}`);

      // Record the instance in the database
      const deployment = await this.prisma.autoDeployment.create({
        data: {
          userId,
          instanceId,
          status: 'active',
          type: instanceType,
          region: this.config.region,
          pipelineId,
          createdAt: new Date(),
          metadata: {
            publicDns,
            tier: user.accountTier
          }
        }
      });

      // Track deployment start for billing
      try {
        await this.billingService.trackDeploymentStart(deployment.id);
      } catch (error) {
        console.error('[InstanceProvisionerService] Error tracking deployment start:', error);
        // Don't fail instance provisioning if billing tracking fails
      }

      return { instanceId, publicDns };
    } catch (error) {
      console.error('[InstanceProvisionerService] Failed to provision instance:', error);
      throw new Error(`Failed to provision instance: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if SSH is ready on the instance
   */
  private async checkSshReady(publicDns: string, maxAttempts = 12): Promise<boolean> {
    console.log(`[InstanceProvisionerService] Checking if SSH is ready on ${publicDns}...`);
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await execAsync(`nc -zv -w5 ${publicDns} 22`);
        console.log(`[InstanceProvisionerService] SSH is ready on ${publicDns}`);
        return true;
      } catch (error) {
        console.log(`[InstanceProvisionerService] SSH not ready yet on ${publicDns}, attempt ${attempt + 1}/${maxAttempts}`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds between attempts
      }
    }
    
    console.log(`[InstanceProvisionerService] SSH failed to become ready on ${publicDns} after ${maxAttempts} attempts`);
    return false;
  }

  /**
   * Wait for an instance to be in running state and return its public DNS
   */
  private async waitForInstanceRunning(instanceId: string, maxAttempts = 30): Promise<string> {
    console.log(`[InstanceProvisionerService] Waiting for instance ${instanceId} to be running...`);
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const command = new DescribeInstancesCommand({
          InstanceIds: [instanceId]
        });

        const result = await this.ec2Client.send(command);
        const instance = result.Reservations?.[0]?.Instances?.[0];

        if (!instance) {
          console.log(`[InstanceProvisionerService] Attempt ${attempt + 1}/${maxAttempts}: Instance ${instanceId} not found yet, waiting...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }

        const state = instance.State?.Name;
        console.log(`[InstanceProvisionerService] Attempt ${attempt + 1}/${maxAttempts}: Instance ${instanceId} state: ${state}`);

        if (state === 'pending') {
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }

        if (state === 'running') {
          if (instance.PublicDnsName) {
            console.log(`[InstanceProvisionerService] Instance ${instanceId} is running with DNS ${instance.PublicDnsName}`);
            
            // Wait for SSH to be ready
            const sshReady = await this.checkSshReady(instance.PublicDnsName);
            if (sshReady) {
              // Add an additional small delay to ensure user data script completes
              await new Promise(resolve => setTimeout(resolve, 5000));
              return instance.PublicDnsName;
            }
            
            // If SSH isn't ready, continue waiting
            await new Promise(resolve => setTimeout(resolve, 10000));
            continue;
          } else {
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
          }
        }

        if (state === 'terminated' || state === 'shutting-down' || state === 'stopped') {
          throw new Error(`Instance ${instanceId} entered invalid state: ${state}`);
        }

        // For any other state, wait and retry
        await new Promise(resolve => setTimeout(resolve, 10000));
      } catch (error) {
        if (error instanceof Error && error.name === 'InvalidInstanceID.NotFound') {
          console.log(`[InstanceProvisionerService] Attempt ${attempt + 1}/${maxAttempts}: Instance ${instanceId} not registered yet, waiting...`);
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Timeout waiting for instance ${instanceId} to be running after ${maxAttempts} attempts`);
  }

  /**
   * Terminate an EC2 instance and track deployment hours
   */
  async terminateInstance(deploymentId: string): Promise<void> {
    try {
      // Get deployment details
      const deployment = await this.prisma.autoDeployment.findUnique({
        where: { id: deploymentId }
      });

      if (!deployment) {
        throw new Error(`Deployment ${deploymentId} not found`);
      }

      // Terminate the EC2 instance
      const command = new TerminateInstancesCommand({
        InstanceIds: [deployment.instanceId]
      });

      await this.ec2Client.send(command);

      // Track deployment end for billing
      try {
        await this.billingService.trackDeploymentEnd(deploymentId);
      } catch (error) {
        console.error('[InstanceProvisionerService] Error tracking deployment end:', error);
        // Don't fail instance termination if billing tracking fails
      }

      // Update deployment status
      await this.prisma.autoDeployment.update({
        where: { id: deploymentId },
        data: {
          status: 'terminated',
          metadata: {
            ...deployment.metadata,
            terminatedAt: new Date().toISOString()
          }
        }
      });
    } catch (error) {
      console.error('[InstanceProvisionerService] Failed to terminate instance:', error);
      throw new Error(`Failed to terminate instance: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async checkInstanceHealth(instanceId: string): Promise<boolean> {
    try {
      // First try using DescribeInstanceStatus
      const command = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });

      const result = await this.ec2Client.send(command);
      const instance = result.Reservations?.[0]?.Instances?.[0];

      if (!instance) {
        return false;
      }

      return instance.State?.Name === 'running';
    } catch (error) {
      console.error(`[InstanceProvisionerService] Error checking instance health:`, error);
      return false;
    }
  }
} 