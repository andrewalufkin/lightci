import { PrismaClient } from '@prisma/client';
import { EC2Client, RunInstancesCommand, DescribeInstancesCommand, _InstanceType, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import { BillingService } from './billing.service.js';
import { execAsync } from '../utils/execAsync.js';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { SshKeyService } from './ssh-key.service.js';

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
  private sshKeyService: SshKeyService;

  constructor(
    private prisma: PrismaClient,
    private config: InstanceConfig,
    awsAccessKeyId: string,
    awsSecretAccessKey: string,
    sshKeyService?: SshKeyService
  ) {
    // Ensure imageId doesn't have brackets
    this.config = {
      ...config,
      imageId: config.imageId.replace(/[\[\]]/g, '')
    };
    
    this.ec2Client = new EC2Client({
      region: config.region,
      credentials: {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey
      }
    });

    this.billingService = new BillingService(prisma);
    this.sshKeyService = sshKeyService || new SshKeyService(prisma);
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
# Update system and install essential tools
set -e  # Exit on error
# Log everything
exec > >(tee -a /var/log/lightci-setup.log) 2>&1

echo "======================================================="
echo "Starting EC2 instance setup for LightCI"
date
echo "======================================================="

echo "Installing essential packages..."
yum update -y
yum install -y curl git wget tar gzip 

# Remove any existing nodejs installation completely
echo "Removing any existing Node.js installation..."
yum remove -y nodejs npm || true
rm -rf /usr/lib/node_modules /usr/local/lib/node_modules || true
rm -f /usr/bin/node /usr/bin/npm /usr/local/bin/node /usr/local/bin/npm || true

# Try multiple installation methods to ensure success
echo "Installing Node.js - Primary method via NodeSource..."
curl -sL https://rpm.nodesource.com/setup_18.x | bash -
yum install -y nodejs

# Verify Node.js installation
if ! command -v node &> /dev/null; then
  echo "First Node.js installation method failed, trying alternative method..."
  # Alternative method: binary installation
  cd /tmp
  wget https://nodejs.org/dist/v18.16.0/node-v18.16.0-linux-x64.tar.gz
  tar -xzf node-v18.16.0-linux-x64.tar.gz
  cd node-v18.16.0-linux-x64
  cp -r bin/* /usr/local/bin/
  cp -r lib/* /usr/local/lib/
  ln -sf /usr/local/bin/node /usr/bin/node
  ln -sf /usr/local/bin/npm /usr/bin/npm
fi

# Verify Node.js installation again
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js installation failed with multiple methods!"
else
  echo "Node.js installation successful: $(node -v)"
fi

# Ensure npm is working, install it directly if needed
if ! command -v npm &> /dev/null; then
  echo "npm not found, installing it directly..."
  curl -L https://www.npmjs.com/install.sh | sh
fi

# Fix npm permissions issue in multiple ways
echo "Setting up npm global permissions..."
mkdir -p /usr/lib/node_modules
chmod -R 777 /usr/lib/node_modules

# Create alternate npm directories for the ec2-user
echo "Creating alternate npm directories..."
mkdir -p /home/ec2-user/.npm-global
chown -R ec2-user:ec2-user /home/ec2-user/.npm-global

# Setup npm to use these directories
echo 'export PATH=/home/ec2-user/.npm-global/bin:$PATH' >> /home/ec2-user/.bashrc
echo 'export NODE_PATH=/home/ec2-user/.npm-global/lib/node_modules:$NODE_PATH' >> /home/ec2-user/.bashrc
sudo -u ec2-user npm config set prefix '/home/ec2-user/.npm-global'

# Install global packages with multiple methods to ensure success
echo "Installing required global npm packages..."
echo "Installing semver globally..."
npm install -g semver || sudo npm install -g semver || sudo -u ec2-user npm install -g semver

echo "Installing PM2 globally..."
npm install -g pm2@latest || sudo npm install -g pm2@latest || sudo -u ec2-user npm install -g pm2@latest

# Create comprehensive symlinks for all binaries
echo "Creating symlinks for Node.js binaries..."
ln -sf $(which node 2>/dev/null || echo '/usr/bin/node') /usr/bin/node 
ln -sf $(which npm 2>/dev/null || echo '/usr/bin/npm') /usr/bin/npm
ln -sf $(which npx 2>/dev/null || echo '/usr/bin/npx') /usr/bin/npx 
ln -sf $(which pm2 2>/dev/null || echo '/usr/bin/pm2') /usr/bin/pm2

# Verify semver was installed correctly
if ! command -v semver &> /dev/null || [ ! -f /usr/lib/node_modules/semver/bin/semver.js ]; then
  echo "semver installation failed, trying alternative method..."
  mkdir -p /usr/lib/node_modules/semver
  chmod 777 /usr/lib/node_modules/semver
  npm install -g --unsafe-perm semver
fi

# Verify PM2 was installed correctly
if ! command -v pm2 &> /dev/null; then
  echo "PM2 installation failed, trying alternative method..."
  sudo -u ec2-user npm install -g pm2@latest
  # Try various locations for PM2
  for pm2path in $(find /usr -name pm2 2>/dev/null) $(find /home -name pm2 2>/dev/null); do
    ln -sf $pm2path /usr/bin/pm2
    if [ -x /usr/bin/pm2 ]; then
      echo "Found PM2 at $pm2path and linked to /usr/bin/pm2"
      break
    fi
  done
fi

# Add paths to multiple profile files to ensure they are always available
echo "Configuring PATH in profile files..."
cat > /etc/profile.d/nodejs-path.sh << 'EOL'
export PATH=$PATH:/usr/local/bin:/usr/bin:/home/ec2-user/.npm-global/bin
export NODE_PATH=$NODE_PATH:/usr/lib/node_modules:/home/ec2-user/.npm-global/lib/node_modules
EOL
chmod +x /etc/profile.d/nodejs-path.sh

# Update more profile files
echo 'source /etc/profile.d/nodejs-path.sh' >> /home/ec2-user/.bashrc
echo 'source /etc/profile.d/nodejs-path.sh' >> /home/ec2-user/.bash_profile

# Ensure SSH daemon is running
echo "Configuring SSH..."
systemctl enable sshd
systemctl start sshd

# Configure SSH for the ec2-user
mkdir -p /home/ec2-user/.ssh
chmod 700 /home/ec2-user/.ssh
touch /home/ec2-user/.ssh/authorized_keys
chmod 600 /home/ec2-user/.ssh/authorized_keys
chown -R ec2-user:ec2-user /home/ec2-user/.ssh

# Create app directory
echo "Creating application directory..."
mkdir -p /home/ec2-user/app
chown -R ec2-user:ec2-user /home/ec2-user/app

# Run thorough verification checks
echo "======================================================="
echo "Running verification checks..."
echo "Node:"
which node 2>&1 || echo "node: Not found in PATH"
node -v 2>&1 || echo "node: Not working properly"

echo "NPM:"
which npm 2>&1 || echo "npm: Not found in PATH"
npm -v 2>&1 || echo "npm: Not working properly"

echo "PM2:"
which pm2 2>&1 || echo "pm2: Not found in PATH"
pm2 -v 2>&1 || echo "pm2: Not working properly"

echo "Global modules:"
npm list -g --depth=0 2>&1

echo "Current PATH: $PATH"
echo "======================================================="

# Create a simple test file to verify PM2 works
sudo -u ec2-user bash -c "cd /home/ec2-user && echo 'console.log(\"PM2 Test\")' > test.js && pm2 delete all 2>/dev/null || true && pm2 start test.js && sleep 2 && pm2 list && pm2 delete all" || echo "PM2 test failed, but continuing..."

echo "Instance setup completed successfully"
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
          id: crypto.randomUUID(),
          userId,
          instanceId,
          status: 'active',
          type: instanceType.replace('_', '.'), // Convert enum format to readable format
          region: this.config.region,
          metadata: {
            imageId: this.config.imageId,
            keyName: this.config.keyName, // Store the key name for future reference
            keyPairName: this.config.keyName, // Add duplicate field with consistent naming
            publicDns,
            createdAt: new Date().toISOString()
          },
          ...(pipelineId ? { pipelineId } : {})
        }
      });

      // Also ensure we update the pipeline deploymentConfig with the key info
      if (pipelineId) {
        try {
          const pipeline = await this.prisma.pipeline.findUnique({
            where: { id: pipelineId }
          });
          
          if (pipeline) {
            // Parse existing config
            let deploymentConfig: any = {};
            try {
              deploymentConfig = typeof pipeline.deploymentConfig === 'string'
                ? JSON.parse(pipeline.deploymentConfig)
                : pipeline.deploymentConfig || {};
            } catch (parseError) {
              console.log(`[InstanceProvisionerService] Error parsing pipeline deployment config: ${parseError.message}`);
              deploymentConfig = {};
            }
            
            // Add the key name to the config
            if (!deploymentConfig.config) {
              deploymentConfig.config = {};
            }
            
            deploymentConfig.config.keyPairName = this.config.keyName;
            
            // Save the updated config
            await this.prisma.pipeline.update({
              where: { id: pipelineId },
              data: {
                deploymentConfig: JSON.stringify(deploymentConfig)
              }
            });
            
            console.log(`[InstanceProvisionerService] Updated pipeline ${pipelineId} with key pair name ${this.config.keyName}`);
          }
        } catch (dbError) {
          console.error(`[InstanceProvisionerService] Error updating pipeline with key info: ${dbError.message}`);
          // Don't fail, just log the error
        }
      }

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
    
    // First, print information about the instance for troubleshooting
    try {
      const dnsInfo = await execAsync(`dig +short ${publicDns}`);
      console.log(`[InstanceProvisionerService] DNS resolution for ${publicDns}: ${dnsInfo.stdout.trim() || 'No DNS record found'}`);
    } catch (error) {
      console.log(`[InstanceProvisionerService] Failed to resolve DNS for ${publicDns}`);
    }
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Try verbose ping to check basic connectivity
        try {
          const pingResult = await execAsync(`ping -c 1 ${publicDns}`);
          console.log(`[InstanceProvisionerService] Ping to ${publicDns} successful: ${pingResult.stdout.includes('1 packets transmitted, 1 received')}`);
        } catch (pingError) {
          console.log(`[InstanceProvisionerService] Ping to ${publicDns} failed, might be firewall blocked`);
        }
        
        // Verbose connectivity checking with detailed error reporting
        console.log(`[InstanceProvisionerService] Attempt ${attempt + 1}/${maxAttempts}: Checking SSH on ${publicDns}...`);
        
        // First attempt with nc command with fallback options
        try {
          // Try the previous command first
          await execAsync(`nc -zv -w5 ${publicDns} 22`);
          console.log(`[InstanceProvisionerService] SSH is ready on ${publicDns} (nc check)`);
          return true;
        } catch (ncError) {
          console.log(`[InstanceProvisionerService] nc -zv -w5 check failed: ${ncError.message}`);
          
          // Try alternate nc syntax without -w flag (more compatible)
          try {
            await execAsync(`nc -zv ${publicDns} 22 -G 5`);
            console.log(`[InstanceProvisionerService] SSH is ready on ${publicDns} (nc alternate check)`);
            return true;
          } catch (ncAltError) {
            console.log(`[InstanceProvisionerService] nc -zv -G 5 check failed: ${ncAltError.message}`);
            
            // Try with a simple timeout command
            try {
              await execAsync(`timeout 5 nc -zv ${publicDns} 22`);
              console.log(`[InstanceProvisionerService] SSH is ready on ${publicDns} (timeout nc check)`);
              return true;
            } catch (timeoutError) {
              console.log(`[InstanceProvisionerService] timeout nc check failed: ${timeoutError.message}`);
              
              // Try with direct SSH command with -o options to fail fast
              try {
                await execAsync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes -v ${publicDns} echo success 2>&1`);
                console.log(`[InstanceProvisionerService] SSH is ready on ${publicDns} (direct ssh check)`);
                return true;
              } catch (sshError) {
                console.log(`[InstanceProvisionerService] Direct SSH check output: ${sshError.stderr || sshError.stdout || sshError.message}`);
                
                // Last resort - try a direct socket connection with curl
                try {
                  await execAsync(`curl --connect-timeout 5 -s telnet://${publicDns}:22`);
                  console.log(`[InstanceProvisionerService] SSH is ready on ${publicDns} (curl check)`);
                  return true;
                } catch (curlError) {
                  console.log(`[InstanceProvisionerService] curl check failed: ${curlError.message}`);
                  // All checks failed for this attempt
                  throw new Error("All connectivity checks failed");
                }
              }
            }
          }
        }
      } catch (error) {
        console.log(`[InstanceProvisionerService] SSH not ready yet on ${publicDns}, attempt ${attempt + 1}/${maxAttempts}`);
        if (attempt === maxAttempts / 2) {
          // At halfway point, check security group settings
          console.log(`[InstanceProvisionerService] SSH still not ready after ${attempt + 1} attempts, checking for firewall/security issues...`);
          await this.checkSecurityGroupSettings();
        }
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds between attempts
      }
    }
    
    console.log(`[InstanceProvisionerService] SSH failed to become ready on ${publicDns} after ${maxAttempts} attempts`);
    return false;
  }

  /**
   * Check security group settings to ensure SSH port is open
   */
  private async checkSecurityGroupSettings(): Promise<void> {
    try {
      console.log(`[InstanceProvisionerService] Checking if security group allows SSH (port 22) traffic...`);
      
      // If we have the AWS SDK for EC2 client available, we could check the security group directly
      // For now, just log a reminder to check the security group manually
      console.log(`[InstanceProvisionerService] MANUAL CHECK REQUIRED: Please ensure security group ${this.config.securityGroupIds.join(', ')} allows inbound traffic on port 22`);
      
      // Attempt to get public IP for troubleshooting
      try {
        const publicIp = await execAsync('curl -s https://checkip.amazonaws.com');
        console.log(`[InstanceProvisionerService] Your current public IP is: ${publicIp.stdout.trim()}`);
        console.log(`[InstanceProvisionerService] Ensure security group allows SSH from this IP or 0.0.0.0/0`);
      } catch (error) {
        console.log(`[InstanceProvisionerService] Could not determine public IP: ${error.message}`);
      }
    } catch (error) {
      console.log(`[InstanceProvisionerService] Error checking security group settings: ${error.message}`);
    }
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
              // Try to verify SSH key works properly
              try {
                await this.validateKeyPair(this.config.keyName, instance.PublicDnsName);
              } catch (keyError) {
                console.log(`[InstanceProvisionerService] WARNING: Key validation failed: ${keyError.message}`);
                // Don't fail the operation, just log warning
              }
              
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
   * Validate that the keypair works with the instance
   */
  private async validateKeyPair(keyName: string, publicDns: string): Promise<void> {
    try {
      console.log(`[InstanceProvisionerService] Validating key pair ${keyName} for ${publicDns}...`);
      
      // First try to get the key from our database by pair name
      const key = await this.sshKeyService.getKeyByPairName(keyName);
      
      if (key) {
        console.log(`[InstanceProvisionerService] Found key in database: ${keyName}`);
        const verified = await this.sshKeyService.verifyKey(key.content, keyName, publicDns);
        
        if (verified) {
          console.log(`[InstanceProvisionerService] SSH key validation successful`);
          return;
        } else {
          console.log(`[InstanceProvisionerService] SSH key from database failed validation, falling back to filesystem lookup`);
        }
      }
      
      // Fall back to the original file system lookup for backward compatibility
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
      const sshDir = path.join(homeDir, '.ssh');
      const possibleKeyPaths = [
        path.join(sshDir, keyName),
        path.join(sshDir, `${keyName}.pem`),
        path.join(sshDir, 'id_rsa'),
        path.join(process.cwd(), `${keyName}.pem`),
        `/etc/ssh/keys/${keyName}.pem`
      ];
      
      let keyFound = false;
      let keyPath = '';
      
      for (const kPath of possibleKeyPaths) {
        try {
          const stats = await fs.promises.stat(kPath);
          if (stats.isFile()) {
            keyFound = true;
            keyPath = kPath;
            console.log(`[InstanceProvisionerService] Found key at: ${keyPath}`);
            break;
          }
        } catch (e) {
          // File doesn't exist, continue checking
        }
      }
      
      if (!keyFound) {
        console.log(`[InstanceProvisionerService] Could not find key ${keyName} in common locations`);
        console.log(`[InstanceProvisionerService] Checked paths: ${possibleKeyPaths.join(', ')}`);
        throw new Error(`SSH key ${keyName} not found locally`);
      }
      
      // Try to connect with the key
      try {
        const result = await execAsync(
          `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "${keyPath}" ec2-user@${publicDns} "echo Successfully connected with key"`
        );
        console.log(`[InstanceProvisionerService] SSH key validation successful: ${result.stdout.trim()}`);
        
        // Store the key in our database if it's not there already
        try {
          const keyContent = fs.readFileSync(keyPath, 'utf8');
          const existingKey = await this.sshKeyService.getKeyByPairName(keyName);
          
          if (!existingKey) {
            const encodedContent = Buffer.from(keyContent).toString('base64');
            await this.sshKeyService.createKey({
              name: keyName,
              content: keyContent,
              keyPairName: keyName
            });
            console.log(`[InstanceProvisionerService] Added key ${keyName} to database for future use`);
          }
        } catch (storeError) {
          console.log(`[InstanceProvisionerService] Note: Could not store key in database: ${storeError.message}`);
          // Continue anyway, this is just an optimization
        }
      } catch (sshError) {
        console.log(`[InstanceProvisionerService] SSH key validation failed: ${sshError.message}`);
        if (sshError.stderr) {
          console.log(`[InstanceProvisionerService] SSH error output: ${sshError.stderr}`);
        }
        
        // Check key permissions
        try {
          const perms = await execAsync(`ls -la "${keyPath}"`);
          console.log(`[InstanceProvisionerService] Key permissions: ${perms.stdout.trim()}`);
          
          // Fix permissions if too open
          if (perms.stdout.includes('-rw-r') || perms.stdout.includes('-rw----r')) {
            console.log(`[InstanceProvisionerService] Attempting to fix key permissions...`);
            await execAsync(`chmod 600 "${keyPath}"`);
            console.log(`[InstanceProvisionerService] Key permissions updated to 600`);
          }
        } catch (permError) {
          console.log(`[InstanceProvisionerService] Could not check key permissions: ${permError.message}`);
        }
        
        throw new Error(`Failed to connect with key ${keyName}: ${sshError.message}`);
      }
    } catch (error) {
      console.log(`[InstanceProvisionerService] Key validation error: ${error.message}`);
      throw error;
    }
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
            ...(typeof deployment.metadata === 'object' && deployment.metadata !== null ? deployment.metadata : {}),
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

  /**
   * Diagnose an existing instance for SSH connectivity issues
   * This method can be called manually to troubleshoot SSH problems
   */
  async diagnoseInstance(instanceId: string): Promise<{ success: boolean; details: string[]; remediation: string[] }> {
    console.log(`[InstanceProvisionerService] Starting diagnostic for instance ${instanceId}...`);
    const details: string[] = [];
    const remediation: string[] = [];
    
    try {
      // Step 1: Check if instance exists and is running
      details.push(`Checking instance ${instanceId} status...`);
      const command = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });

      const result = await this.ec2Client.send(command);
      const instance = result.Reservations?.[0]?.Instances?.[0];

      if (!instance) {
        details.push(`❌ Instance ${instanceId} not found`);
        remediation.push('Verify the instance ID is correct');
        return { success: false, details, remediation };
      }

      const state = instance.State?.Name;
      details.push(`Instance state: ${state}`);
      
      if (state !== 'running') {
        details.push(`❌ Instance is not in running state (current: ${state})`);
        remediation.push('Start the instance if it is stopped');
        remediation.push('Wait for the instance to finish initialization if pending');
        return { success: false, details, remediation };
      }
      
      details.push(`✅ Instance is running`);
      
      // Step 2: Check public DNS and IP
      if (!instance.PublicDnsName) {
        details.push(`❌ Instance does not have a public DNS name`);
        remediation.push('Ensure the instance is in a public subnet');
        remediation.push('Check if the VPC has an internet gateway attached');
        return { success: false, details, remediation };
      }
      
      details.push(`Public DNS: ${instance.PublicDnsName}`);
      details.push(`Public IP: ${instance.PublicIpAddress || 'Not available'}`);
      
      // Step 3: Check connectivity
      details.push(`Checking basic connectivity...`);
      try {
        const pingResult = await execAsync(`ping -c 1 ${instance.PublicDnsName}`);
        const pingSuccess = pingResult.stdout.includes('1 packets transmitted, 1 received');
        details.push(pingSuccess ? `✅ Ping successful` : `⚠️ Ping partially successful but with packet loss`);
      } catch (pingError) {
        details.push(`⚠️ Ping failed - could be firewall or ICMP blocking (normal for some cloud providers)`);
      }
      
      // Step 4: Check SSH port
      details.push(`Checking SSH port connectivity...`);
      let portAccessible = false;
      
      try {
        await execAsync(`nc -zv ${instance.PublicDnsName} 22 -w 5`);
        details.push(`✅ SSH port 22 is accessible`);
        portAccessible = true;
      } catch (ncError) {
        try {
          await execAsync(`curl --connect-timeout 5 -s telnet://${instance.PublicDnsName}:22`);
          details.push(`✅ SSH port 22 is accessible (verified with curl)`);
          portAccessible = true;
        } catch (curlError) {
          details.push(`❌ SSH port 22 appears to be closed or blocked`);
          remediation.push('Check security group rules to ensure port 22 is open');
          remediation.push('Verify that no network ACLs are blocking port 22');
        }
      }
      
      // Step 5: Check security groups
      details.push(`Checking security group configuration...`);
      const securityGroups = instance.SecurityGroups || [];
      
      if (securityGroups.length === 0) {
        details.push(`❌ No security groups attached to instance`);
        remediation.push('Attach a security group that allows SSH access');
      } else {
        details.push(`Instance has ${securityGroups.length} security groups:`);
        securityGroups.forEach(sg => {
          details.push(`- ${sg.GroupId}: ${sg.GroupName}`);
        });
        
        // We can't directly check the security group rules without additional API calls
        // but we can infer from port connectivity
        if (!portAccessible) {
          details.push(`⚠️ Security groups may not allow SSH access`);
          remediation.push('Add an inbound rule to allow TCP port 22 from your IP or 0.0.0.0/0');
        }
      }
      
      // Step 6: Check SSH key configuration 
      details.push(`Checking SSH key configuration...`);
      
      if (!instance.KeyName) {
        details.push(`❌ No key pair associated with instance`);
        remediation.push('You cannot add a key pair after launch. Consider terminating and relaunching with a key pair');
        return { success: false, details, remediation };
      }
      
      details.push(`Instance using key pair: ${instance.KeyName}`);
      
      if (instance.KeyName !== this.config.keyName) {
        details.push(`⚠️ Instance key pair (${instance.KeyName}) differs from configured key (${this.config.keyName})`);
        remediation.push(`Use the correct key (${instance.KeyName}) for SSH connections`);
        remediation.push(`Update configuration to use key: ${instance.KeyName}`);
      } else {
        details.push(`✅ Key pair configuration matches expected value`);
      }
      
      // Try to validate the key if port is accessible
      if (portAccessible) {
        try {
          await this.validateKeyPair(instance.KeyName, instance.PublicDnsName);
          details.push(`✅ Successfully validated SSH key access`);
        } catch (keyError) {
          details.push(`❌ Failed to connect with SSH key: ${keyError.message}`);
          remediation.push('Verify the key file exists and has correct permissions (chmod 600)');
          remediation.push('Check that the user data script properly configured authorized_keys');
        }
      }
      
      // Final summary
      const success = portAccessible && details.filter(d => d.includes('❌')).length === 0;
      if (success) {
        details.push(`✅ Diagnostic complete: SSH appears to be correctly configured`);
      } else {
        details.push(`❌ Diagnostic complete: SSH issues detected, see recommendations`);
      }
      
      return { success, details, remediation };
    } catch (error) {
      details.push(`❌ Error during diagnostic: ${error.message}`);
      remediation.push('Check AWS credentials and permissions');
      return { success: false, details, remediation };
    }
  }
} 