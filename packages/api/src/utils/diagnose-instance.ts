#!/usr/bin/env node
// packages/api/src/utils/diagnose-instance.ts
import { config } from 'dotenv';
import { InstanceProvisionerService, InstanceConfig } from '../services/instance-provisioner.service.js';
import { PrismaClient } from '@prisma/client';

// Load environment variables from .env file
config();

/**
 * A utility script to diagnose SSH connectivity issues with EC2 instances
 * Usage: npx ts-node src/utils/diagnose-instance.ts i-0123456789abcdef0
 */
async function main() {
  if (process.argv.length < 3) {
    console.error('Please provide an instance ID as an argument');
    console.error('Usage: npx ts-node src/utils/diagnose-instance.ts i-0123456789abcdef0');
    process.exit(1);
  }

  const instanceId = process.argv[2];
  console.log(`Starting diagnosis for instance ${instanceId}...`);

  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const keyName = process.env.AWS_EC2_KEY_NAME;
  const securityGroupId = process.env.AWS_SECURITY_GROUP_ID;
  const subnetId = process.env.AWS_SUBNET_ID;
  const imageId = process.env.AWS_AMI_ID || 'ami-0889a44b331db0194';

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    console.error('AWS credentials not found. Make sure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set in .env file');
    process.exit(1);
  }

  if (!keyName) {
    console.error('EC2 key name not found. Make sure AWS_EC2_KEY_NAME is set in .env file');
    process.exit(1);
  }

  if (!securityGroupId) {
    console.error('Security group ID not found. Make sure AWS_SECURITY_GROUP_ID is set in .env file');
    process.exit(1);
  }

  if (!subnetId) {
    console.error('Subnet ID not found. Make sure AWS_SUBNET_ID is set in .env file');
    process.exit(1);
  }

  console.log('AWS Configuration:');
  console.log(`- Region: ${region}`);
  console.log(`- Key Name: ${keyName}`);
  console.log(`- Security Group: ${securityGroupId}`);
  console.log(`- Subnet: ${subnetId}`);

  const instanceConfig: InstanceConfig = {
    region,
    imageId,
    keyName,
    securityGroupIds: [securityGroupId],
    subnetId
  };

  const prisma = new PrismaClient();
  const instanceProvisioner = new InstanceProvisionerService(
    prisma,
    instanceConfig,
    awsAccessKeyId,
    awsSecretAccessKey
  );

  try {
    const diagnosis = await instanceProvisioner.diagnoseInstance(instanceId);
    
    console.log('\nDiagnostic Results:');
    diagnosis.details.forEach(detail => console.log(detail));
    
    if (diagnosis.remediation.length > 0) {
      console.log('\nRecommended Actions:');
      diagnosis.remediation.forEach((remedy, i) => console.log(`${i + 1}. ${remedy}`));
    }
    
    process.exit(diagnosis.success ? 0 : 1);
  } catch (error) {
    console.error('Error running diagnosis:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 