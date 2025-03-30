#!/usr/bin/env node
// packages/api/src/utils/recover-instance-key.ts
import { config } from 'dotenv';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execAsync } from './execAsync.js';

// Load environment variables from .env file
config();

/**
 * Utility script to create a helper SSH key for manually connecting to an existing instance
 * Usage: npx tsx src/utils/recover-instance-key.ts i-0df0fb86c42519744
 */
async function main() {
  if (process.argv.length < 3) {
    console.error('Please provide an instance ID as an argument');
    console.error('Usage: npx tsx src/utils/recover-instance-key.ts i-0df0fb86c42519744');
    process.exit(1);
  }

  const instanceId = process.argv[2];
  console.log(`Creating recovery access for instance ${instanceId}...`);

  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_DEFAULT_REGION || 'us-east-1';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    console.error('AWS credentials not found. Make sure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set in .env file');
    process.exit(1);
  }

  // Create EC2 client
  const ec2Client = new EC2Client({
    region,
    credentials: {
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey
    }
  });

  try {
    // Get instance details
    console.log(`Fetching details for instance ${instanceId}...`);
    
    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId]
    });
    
    const result = await ec2Client.send(command);
    const instance = result.Reservations?.[0]?.Instances?.[0];
    
    if (!instance) {
      console.error(`Instance ${instanceId} not found`);
      process.exit(1);
    }
    
    if (!instance.PublicDnsName) {
      console.error(`Instance ${instanceId} does not have a public DNS name`);
      process.exit(1);
    }
    
    // Create a local SSH key
    const keyName = `lightci-recovery-${instanceId}`;
    const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
    const sshDir = path.join(homeDir, '.ssh');
    const keyPath = path.join(sshDir, `${keyName}`);
    const publicKeyPath = `${keyPath}.pub`;
    
    console.log(`Creating a new SSH key pair at ${keyPath}...`);
    
    // Create SSH directory if it doesn't exist
    try {
      await fs.mkdir(sshDir, { recursive: true });
    } catch (err) {
      // Directory might already exist
    }
    
    // Generate new SSH key
    try {
      await execAsync(`ssh-keygen -t rsa -b 2048 -f "${keyPath}" -N "" -C "lightci-recovery-key"`);
      console.log(`✅ Created new SSH key: ${keyPath}`);
      
      // Fix permissions
      await execAsync(`chmod 600 "${keyPath}"`);
      await execAsync(`chmod 644 "${publicKeyPath}"`);
      
      // Read the public key
      const publicKey = await fs.readFile(publicKeyPath, 'utf8');
      console.log('\nTo access your instance, you need to add this public key to the authorized_keys file on the instance.');
      console.log('If you have a way to access the instance (e.g., through AWS console or another key), perform these steps:');
      console.log('\n1. Create a file with this public key:');
      console.log(`${publicKey}`);
      console.log('\n2. Connect to the instance and add the key:');
      console.log(`   echo "${publicKey}" >> ~/.ssh/authorized_keys`);
      
      console.log('\nAlternatively, you can terminate this instance and create a new one that will save the key properly.');
      console.log(`\nWhen you have access, you can connect with:\n  ssh -i ${keyPath} ec2-user@${instance.PublicDnsName}`);
    } catch (error) {
      console.error('Failed to create SSH key:', error);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 