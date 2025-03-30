#!/usr/bin/env node
// packages/api/src/utils/fix-instance-security.ts
import { config } from 'dotenv';
import { EC2Client, ModifyInstanceAttributeCommand } from '@aws-sdk/client-ec2';
import { execAsync } from './execAsync.js';
import * as path from 'path';
import * as fs from 'fs/promises';

// Load environment variables from .env file
config();

/**
 * Utility script to fix security group and SSH access for an EC2 instance
 * Usage: npx tsx src/utils/fix-instance-security.ts i-0df0fb86c42519744 lightci-feb88e83d56666ad
 */
async function main() {
  if (process.argv.length < 3) {
    console.error('Please provide an instance ID as an argument');
    console.error('Usage: npx tsx src/utils/fix-instance-security.ts i-0df0fb86c42519744 [keyName]');
    process.exit(1);
  }

  const instanceId = process.argv[2];
  const keyName = process.argv.length >= 4 ? process.argv[3] : undefined;
  console.log(`Starting security fix for instance ${instanceId}...`);

  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const securityGroupId = process.env.AWS_SECURITY_GROUP_ID;

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    console.error('AWS credentials not found. Make sure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set in .env file');
    process.exit(1);
  }

  if (!securityGroupId) {
    console.error('Security group ID not found. Make sure AWS_SECURITY_GROUP_ID is set in .env file');
    process.exit(1);
  }

  console.log('AWS Configuration:');
  console.log(`- Region: ${region}`);
  console.log(`- Security Group to use: ${securityGroupId}`);
  
  // Create EC2 client
  const ec2Client = new EC2Client({
    region,
    credentials: {
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey
    }
  });

  try {
    // Modify the instance to use the correct security group
    console.log(`Updating instance ${instanceId} to use security group ${securityGroupId}...`);
    
    const command = new ModifyInstanceAttributeCommand({
      InstanceId: instanceId,
      Groups: [securityGroupId]
    });
    
    await ec2Client.send(command);
    console.log(`✅ Successfully updated security group for instance ${instanceId}`);
    
    // If key name is provided, try to retrieve and save it locally
    if (keyName) {
      console.log(`Checking for SSH key: ${keyName}`);
      
      // Check if key already exists locally
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
      const sshDir = path.join(homeDir, '.ssh');
      const keyPath = path.join(sshDir, `${keyName}.pem`);
      
      try {
        await fs.access(keyPath);
        console.log(`✅ SSH key already exists at: ${keyPath}`);
      } catch (err) {
        console.log(`SSH key not found locally. You need to manually save the key.`);
        console.log(`For automatic deployments, a key pair was likely generated but not saved.`);
        console.log(`You may need to terminate this instance and create a new one.`);
      }
    }
    
    console.log('\nNext Steps:');
    console.log('1. Wait a minute for security group changes to take effect');
    console.log('2. Try connecting to the instance with SSH:');
    
    if (keyName) {
      console.log(`   ssh -i ~/.ssh/${keyName}.pem ec2-user@<instance-public-dns>`);
    } else {
      console.log(`   ssh -i <your-key-file.pem> ec2-user@<instance-public-dns>`);
    }
    
    console.log('3. If SSH still fails, run the diagnosis tool for more information:');
    console.log(`   npm run diagnose-instance ${instanceId}`);
    
    process.exit(0);
  } catch (error) {
    console.error('Error updating instance:', error);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 