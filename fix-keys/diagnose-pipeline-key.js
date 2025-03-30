#!/usr/bin/env node
// fix-keys/diagnose-pipeline-key.js
// A utility to diagnose and fix SSH key issues in pipeline configurations

const { PrismaClient } = require('@prisma/client');
const fs = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Initialize Prisma client
const prisma = new PrismaClient();

async function main() {
  if (process.argv.length < 3) {
    console.error('Please provide a pipeline ID');
    console.error('Usage: node diagnose-pipeline-key.js PIPELINE_ID');
    process.exit(1);
  }

  const pipelineId = process.argv[2];
  console.log(`Diagnosing SSH key for pipeline: ${pipelineId}`);

  try {
    // Get pipeline deployment config
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: pipelineId }
    });

    if (!pipeline) {
      console.error(`Pipeline ${pipelineId} not found`);
      process.exit(1);
    }

    console.log(`Found pipeline: ${pipeline.name}`);

    if (!pipeline.deploymentConfig) {
      console.error(`Pipeline ${pipelineId} has no deployment configuration`);
      process.exit(1);
    }

    // Parse deployment config
    let deploymentConfig;
    try {
      deploymentConfig = typeof pipeline.deploymentConfig === 'string'
        ? JSON.parse(pipeline.deploymentConfig)
        : pipeline.deploymentConfig;
      
      console.log(`Successfully parsed deployment config`);
    } catch (error) {
      console.error(`Error parsing deployment config:`, error);
      process.exit(1);
    }

    // Check if we have EC2 SSH key
    let sshKey = '';
    let keySource = '';

    if (deploymentConfig.ec2SshKey) {
      sshKey = deploymentConfig.ec2SshKey;
      keySource = 'ec2SshKey';
      console.log(`Found SSH key in ec2SshKey (${sshKey.length} chars)`);
    } else if (deploymentConfig.ec2SshKeyEncoded) {
      try {
        sshKey = Buffer.from(deploymentConfig.ec2SshKeyEncoded, 'base64').toString('utf-8');
        keySource = 'ec2SshKeyEncoded (decoded)';
        console.log(`Found encoded SSH key, decoded to ${sshKey.length} chars`);
      } catch (err) {
        console.error(`Failed to decode SSH key: ${err.message}`);
      }
    } else if (deploymentConfig.config?.ec2SshKey) {
      sshKey = deploymentConfig.config.ec2SshKey;
      keySource = 'config.ec2SshKey';
      console.log(`Found SSH key in config.ec2SshKey (${sshKey.length} chars)`);
    } else {
      console.error(`No SSH key found in deployment config`);
      process.exit(1);
    }

    // Validate SSH key format
    const keyStartsWithBegin = sshKey.trim().startsWith('-----BEGIN');
    const keyEndsWithEnd = sshKey.trim().endsWith('-----');
    const keyLines = sshKey.split(/\r?\n/).filter(line => line.trim() !== '');
    const hasMultipleLines = keyLines.length > 2;

    console.log(`Key format check:`);
    console.log(`- Starts with -----BEGIN: ${keyStartsWithBegin}`);
    console.log(`- Ends with -----: ${keyEndsWithEnd}`);
    console.log(`- Has multiple lines: ${hasMultipleLines} (${keyLines.length} lines)`);

    // Fix key format if needed
    let fixedKey = sshKey;
    if (keyStartsWithBegin && keyEndsWithEnd && !hasMultipleLines) {
      console.log(`SSH key is in a single line format, reformatting...`);
      
      // Extract begin and end headers
      const beginMatch = sshKey.match(/(-----BEGIN [^-]+ -----)/);
      const endMatch = sshKey.match(/(-----END [^-]+ -----)/);
      
      if (beginMatch && endMatch) {
        const beginHeader = beginMatch[1];
        const endHeader = endMatch[1];
        
        // Clean all whitespace from content
        let content = sshKey.substring(
          sshKey.indexOf(beginHeader) + beginHeader.length,
          sshKey.indexOf(endHeader)
        ).replace(/\s+/g, '');
        
        // Reformat to standard PEM structure with 64-char lines
        const contentLines = [];
        for (let i = 0; i < content.length; i += 64) {
          contentLines.push(content.substring(i, i + 64));
        }
        
        // Rebuild with proper format
        fixedKey = [
          beginHeader,
          ...contentLines,
          endHeader
        ].join('\n');
        
        console.log(`Reformatted SSH key to proper PEM format with ${contentLines.length + 2} lines`);
      }
    }

    // Save the key to a temporary file for testing
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-key-fix-'));
    const keyPath = path.join(tmpDir, 'ssh_key.pem');
    
    await fs.writeFile(keyPath, fixedKey, { mode: 0o600 });
    console.log(`Saved SSH key to ${keyPath}`);

    // Test the key if we have instance information
    if (deploymentConfig.publicDns || deploymentConfig.ec2InstanceUrl) {
      const host = deploymentConfig.publicDns || deploymentConfig.ec2InstanceUrl;
      const username = deploymentConfig.ec2Username || 'ec2-user';
      
      console.log(`Testing SSH key with ${username}@${host}...`);
      
      try {
        execSync(`ssh-keygen -y -f "${keyPath}"`, { stdio: 'pipe' });
        console.log(`✅ SSH key is valid according to ssh-keygen`);
      } catch (error) {
        console.error(`❌ SSH key is not a valid private key: ${error.message}`);
        console.log(`The key may be corrupted or in an incorrect format`);
      }
    }

    // Update the deployment config with the fixed key
    console.log(`\nWould you like to update the pipeline with the fixed SSH key? (y/n)`);
    process.stdout.write('> ');
    
    process.stdin.once('data', async (data) => {
      const input = data.toString().trim().toLowerCase();
      
      if (input === 'y' || input === 'yes') {
        // Update all key locations for consistency
        deploymentConfig.ec2SshKey = fixedKey;
        if (deploymentConfig.config) {
          deploymentConfig.config.ec2SshKey = fixedKey;
        }
        // Update encoded key
        deploymentConfig.ec2SshKeyEncoded = Buffer.from(fixedKey).toString('base64');
        
        // Update the database
        await prisma.pipeline.update({
          where: { id: pipelineId },
          data: {
            deploymentConfig: JSON.stringify(deploymentConfig)
          }
        });
        
        console.log(`✅ Successfully updated pipeline with fixed SSH key`);
        
        // Save a backup of the key
        const backupPath = `./ssh_key_backup_${pipelineId}.pem`;
        await fs.writeFile(backupPath, fixedKey, { mode: 0o600 });
        console.log(`✅ Backup of fixed key saved to ${backupPath}`);
      } else {
        console.log(`No changes made to the pipeline configuration`);
      }
      
      // Cleanup
      try {
        await fs.rm(tmpDir, { recursive: true });
      } catch (error) {
        console.error(`Error cleaning up temporary directory: ${error.message}`);
      }
      
      await prisma.$disconnect();
      process.exit(0);
    });
  } catch (error) {
    console.error(`Error:`, error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

main(); 