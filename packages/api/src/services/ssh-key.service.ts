import { PrismaClient } from '@prisma/client';
import { EC2Client, CreateKeyPairCommand, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execAsync } from '../utils/execAsync.js';
import mkdirp from 'mkdirp';

export interface AwsCredentials {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class SshKeyService {
  private keyStorageDir: string;

  constructor(private prisma: PrismaClient) {
    // Set up centralized storage for SSH keys
    this.keyStorageDir = process.env.SSH_KEY_STORAGE_DIR || '/tmp/lightci/ssh-keys';
    
    // Ensure the directory exists with proper permissions
    try {
      mkdirp.sync(this.keyStorageDir);
      fs.chmodSync(this.keyStorageDir, 0o700);
    } catch (error) {
      console.error(`[SshKeyService] Error setting up key storage directory: ${error.message}`);
    }
  }

  /**
   * Create a new SSH key and store it
   */
  async createKey(
    options: {
      name: string;
      content?: string;
      keyPairName?: string;
      awsCredentials?: AwsCredentials;
    }
  ): Promise<any> {
    const { name, content, keyPairName, awsCredentials } = options;
    try {
      // Generate a unique key pair name if not provided
      const effectiveKeyName = keyPairName || `${name}-${crypto.randomUUID().substring(0, 8)}`;
      
      let keyContent = content;
      let encodedContent = '';
      
      // If content not provided, create a new key pair in AWS
      if (!keyContent && awsCredentials) {
        // Create EC2 client with credentials
        const ec2Client = new EC2Client({
          region: awsCredentials.region || 'us-east-1',
          credentials: {
            accessKeyId: awsCredentials.accessKeyId,
            secretAccessKey: awsCredentials.secretAccessKey
          }
        });
        
        // Create a new key pair in AWS
        const createKeyPairCommand = new CreateKeyPairCommand({
          KeyName: effectiveKeyName
        });
        
        const keyPairResult = await ec2Client.send(createKeyPairCommand);
        keyContent = keyPairResult.KeyMaterial;
        encodedContent = Buffer.from(keyContent).toString('base64');
        
        // Save the key to disk
        await this.writeKeyToFile(effectiveKeyName, keyContent);
      } else if (keyContent) {
        // If content is provided, just encode it
        encodedContent = Buffer.from(keyContent).toString('base64');
        
        // Save to disk
        await this.writeKeyToFile(effectiveKeyName, keyContent);
      } else {
        throw new Error('Either key content or AWS credentials must be provided to create a key');
      }
      
      // Store in database
      return await this.prisma.sshKey.create({
        data: {
          name,
          content: keyContent,
          encodedContent,
          keyPairName: effectiveKeyName,
        }
      });
    } catch (error) {
      console.error(`[SshKeyService] Error creating SSH key: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get an SSH key by ID
   */
  async getKeyById(id: string): Promise<any> {
    try {
      return await this.prisma.sshKey.findUnique({
        where: { id }
      });
    } catch (error) {
      console.error(`[SshKeyService] Error getting SSH key by ID: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get an SSH key by pair name
   */
  async getKeyByPairName(keyPairName: string): Promise<any> {
    try {
      return await this.prisma.sshKey.findFirst({
        where: { keyPairName }
      });
    } catch (error) {
      console.error(`[SshKeyService] Error getting SSH key by pair name: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get an SSH key associated with an EC2 instance
   */
  async getKeyForInstance(instanceId: string, region: string, credentials: AwsCredentials): Promise<any> {
    try {
      // Create EC2 client
      const ec2Client = new EC2Client({
        region,
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey
        }
      });
      
      // Get instance details
      const describeCommand = new DescribeInstancesCommand({
        InstanceIds: [instanceId]
      });
      
      const response = await ec2Client.send(describeCommand);
      const instance = response.Reservations?.[0]?.Instances?.[0];
      
      if (!instance) {
        throw new Error(`Instance ${instanceId} not found`);
      }
      
      const keyName = instance.KeyName;
      
      if (!keyName) {
        throw new Error(`No key associated with instance ${instanceId}`);
      }
      
      console.log(`[SshKeyService] Found key name for instance ${instanceId}: ${keyName}`);
      
      // Look for this key in our database
      const key = await this.getKeyByPairName(keyName);
      
      if (key) {
        return key;
      }
      
      console.log(`[SshKeyService] Key ${keyName} not found in database, checking filesystem`);
      
      // If not in database, check the filesystem
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
      const sshDir = path.join(homeDir, '.ssh');
      const possibleKeyPaths = [
        path.join(sshDir, keyName),
        path.join(sshDir, `${keyName}.pem`),
        path.join(process.cwd(), `${keyName}.pem`),
        `/etc/ssh/keys/${keyName}.pem`
      ];
      
      for (const keyPath of possibleKeyPaths) {
        try {
          if (fs.existsSync(keyPath)) {
            console.log(`[SshKeyService] Found key file at ${keyPath}`);
            const keyContent = fs.readFileSync(keyPath, 'utf8');
            
            // Store it in our database
            const newKey = await this.createKey({
              name: keyName,
              content: keyContent,
              keyPairName: keyName
            });
            
            return newKey;
          }
        } catch (e) {
          // File doesn't exist or can't be read, continue checking
        }
      }
      
      throw new Error(`SSH key ${keyName} for instance ${instanceId} not found in database or filesystem`);
    } catch (error) {
      console.error(`[SshKeyService] Error getting key for instance: ${error.message}`);
      throw error;
    }
  }

  /**
   * Write an SSH key to a file and return the path
   */
  async writeKeyToFile(keyName: string, keyContent: string): Promise<string> {
    try {
      const keyPath = path.join(this.keyStorageDir, `${keyName}.pem`);
      
      // Write key to file with the right permissions
      fs.writeFileSync(keyPath, keyContent, { mode: 0o600 });
      
      return keyPath;
    } catch (error) {
      console.error(`[SshKeyService] Error writing SSH key to file: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify that an SSH key works with a host
   */
  async verifyKey(keyContent: string, keyName: string, host: string): Promise<boolean> {
    try {
      // Write key to a temporary file
      const keyPath = await this.writeKeyToFile(keyName, keyContent);
      
      // Try a simple SSH connection
      try {
        const result = await execAsync(
          `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "${keyPath}" ec2-user@${host} "echo Successfully connected with key"`
        );
        
        console.log(`[SshKeyService] Key verification successful: ${result.stdout.trim()}`);
        return true;
      } catch (error) {
        console.log(`[SshKeyService] Key verification failed: ${error.message}`);
        return false;
      }
    } catch (error) {
      console.error(`[SshKeyService] Error verifying SSH key: ${error.message}`);
      return false;
    }
  }

  /**
   * Associate an SSH key with a deployment
   */
  async associateKeyWithDeployment(keyId: string, deploymentId: string): Promise<void> {
    try {
      await this.prisma.autoDeployment.update({
        where: { id: deploymentId },
        data: { sshKeyId: keyId }
      });
      
      console.log(`[SshKeyService] Associated key ${keyId} with deployment ${deploymentId}`);
    } catch (error) {
      console.error(`[SshKeyService] Error associating key with deployment: ${error.message}`);
      throw error;
    }
  }
} 