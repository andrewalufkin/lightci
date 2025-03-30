#!/usr/bin/env node
// fix-keys/reset-ssh-key.js
// A utility to reset the SSH key in a pipeline's deployment configuration

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

async function main() {
  console.log('Pipeline SSH Key Reset Tool');
  console.log('==========================\n');

  const prisma = new PrismaClient();
  
  try {
    // Get pipeline ID
    const pipelineId = await prompt('Enter pipeline ID: ');
    if (!pipelineId) {
      console.error('Pipeline ID is required');
      process.exit(1);
    }
    
    // Get the pipeline
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: pipelineId }
    });
    
    if (!pipeline) {
      console.error(`Pipeline ${pipelineId} not found`);
      process.exit(1);
    }
    
    console.log(`Found pipeline: ${pipeline.name}`);
    
    // Get SSH key path
    const keyPath = await prompt('Enter path to SSH key file (.pem): ');
    if (!keyPath || !fs.existsSync(keyPath)) {
      console.error('SSH key file not found');
      process.exit(1);
    }
    
    // Read SSH key
    const sshKey = fs.readFileSync(keyPath, 'utf8');
    console.log(`Read SSH key (${sshKey.length} chars)`);
    
    // Parse deployment config
    let deploymentConfig;
    try {
      deploymentConfig = typeof pipeline.deploymentConfig === 'string'
        ? JSON.parse(pipeline.deploymentConfig)
        : pipeline.deploymentConfig;
      
      console.log('Successfully parsed deployment config');
    } catch (error) {
      console.error(`Error parsing deployment config:`, error);
      process.exit(1);
    }
    
    // Confirm platform
    if (deploymentConfig.platform !== 'aws_ec2') {
      console.log(`Warning: Pipeline platform is ${deploymentConfig.platform}, not aws_ec2`);
      const proceed = await prompt('Continue anyway? (y/n): ');
      if (proceed.toLowerCase() !== 'y') {
        process.exit(0);
      }
    }
    
    // Update the SSH key in all locations
    deploymentConfig.ec2SshKey = sshKey;
    if (deploymentConfig.config) {
      deploymentConfig.config.ec2SshKey = sshKey;
    }
    deploymentConfig.ec2SshKeyEncoded = Buffer.from(sshKey).toString('base64');
    
    // Confirm update
    console.log('\nReady to update pipeline with the new SSH key');
    const confirm = await prompt('Proceed with update? (y/n): ');
    
    if (confirm.toLowerCase() === 'y') {
      // Update the pipeline configuration
      await prisma.pipeline.update({
        where: { id: pipelineId },
        data: {
          deploymentConfig: JSON.stringify(deploymentConfig)
        }
      });
      
      console.log('✅ Successfully updated pipeline with new SSH key');
    } else {
      console.log('Operation cancelled');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
    rl.close();
  }
}

main(); 