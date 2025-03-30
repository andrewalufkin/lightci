#!/usr/bin/env node
// fix-keys/fix-ec2-ssh.js
// A utility to diagnose and fix SSH connectivity issues with EC2 instances

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
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
  console.log('EC2 SSH Connection Diagnostic Tool');
  console.log('=================================\n');
  
  // Gather required information
  const host = await prompt('Enter EC2 instance public DNS or IP: ');
  if (!host) {
    console.error('Host is required');
    process.exit(1);
  }
  
  const username = await prompt('Enter username (default: ec2-user): ') || 'ec2-user';
  
  // Look for existing keys
  console.log('\nSearching for SSH keys...');
  
  const homeDir = os.homedir();
  const sshDir = path.join(homeDir, '.ssh');
  let keyPath = '';
  
  try {
    const files = fs.readdirSync(sshDir);
    const keyFiles = files.filter(file => 
      file.endsWith('.pem') || 
      file === 'id_rsa' || 
      file === 'id_ed25519' || 
      file.includes('lightci')
    );
    
    if (keyFiles.length > 0) {
      console.log(`Found ${keyFiles.length} potential SSH keys:`);
      for (let i = 0; i < keyFiles.length; i++) {
        console.log(`${i + 1}. ${keyFiles[i]}`);
      }
      
      const keyIndex = await prompt('Select a key by number (or press Enter to provide a path): ');
      if (keyIndex && !isNaN(keyIndex) && parseInt(keyIndex) <= keyFiles.length) {
        keyPath = path.join(sshDir, keyFiles[parseInt(keyIndex) - 1]);
      }
    }
    
    if (!keyPath) {
      keyPath = await prompt('Enter the full path to your private key: ');
      if (!keyPath) {
        console.error('SSH key is required');
        process.exit(1);
      }
    }
  } catch (error) {
    console.error(`Error searching for SSH keys: ${error.message}`);
    keyPath = await prompt('Enter the full path to your private key: ');
    if (!keyPath) {
      console.error('SSH key is required');
      process.exit(1);
    }
  }
  
  // Check key permissions
  try {
    const stats = fs.statSync(keyPath);
    const permissions = stats.mode & 0o777;
    
    console.log(`\nKey file permissions: ${permissions.toString(8)}`);
    if (permissions !== 0o600) {
      console.log('SSH key has incorrect permissions. SSH requires 600 (read/write for owner only).');
      const fixPerms = await prompt('Fix permissions? (y/n): ');
      
      if (fixPerms.toLowerCase() === 'y') {
        fs.chmodSync(keyPath, 0o600);
        console.log('Permissions updated to 600');
      }
    } else {
      console.log('SSH key has correct permissions (600)');
    }
  } catch (error) {
    console.error(`Error checking key permissions: ${error.message}`);
  }
  
  // Validate SSH key format
  console.log('\nValidating SSH key format...');
  try {
    execSync(`ssh-keygen -y -f "${keyPath}"`, { stdio: 'pipe' });
    console.log('✅ SSH key is valid');
  } catch (error) {
    console.error(`❌ SSH key validation failed: ${error.message}`);
    console.log('\nThe key may be corrupted or in an invalid format.');
    
    // Attempt to fix key format
    const keyContent = fs.readFileSync(keyPath, 'utf8');
    const beginMatch = keyContent.match(/(-----BEGIN [^-]+ -----)/);
    const endMatch = keyContent.match(/(-----END [^-]+ -----)/);
    
    if (beginMatch && endMatch) {
      console.log('Key appears to have PEM headers but may have formatting issues.');
      const fixFormat = await prompt('Attempt to fix key format? (y/n): ');
      
      if (fixFormat.toLowerCase() === 'y') {
        // Create backup
        const backupPath = `${keyPath}.backup`;
        fs.copyFileSync(keyPath, backupPath);
        console.log(`Backup created at ${backupPath}`);
        
        const beginHeader = beginMatch[1];
        const endHeader = endMatch[1];
        
        // Clean all whitespace from content
        let content = keyContent.substring(
          keyContent.indexOf(beginHeader) + beginHeader.length,
          keyContent.indexOf(endHeader)
        ).replace(/\s+/g, '');
        
        // Reformat to standard PEM structure with 64-char lines
        const contentLines = [];
        for (let i = 0; i < content.length; i += 64) {
          contentLines.push(content.substring(i, i + 64));
        }
        
        // Rebuild with proper format
        const fixedKey = [
          beginHeader,
          ...contentLines,
          endHeader
        ].join('\n');
        
        fs.writeFileSync(keyPath, fixedKey, { mode: 0o600 });
        console.log('Key reformatted to proper PEM format');
        
        // Verify the fixed key
        try {
          execSync(`ssh-keygen -y -f "${keyPath}"`, { stdio: 'pipe' });
          console.log('✅ Fixed key is valid');
        } catch (verifyError) {
          console.error(`❌ Key still invalid after reformatting: ${verifyError.message}`);
          console.log(`The backup is available at ${backupPath}`);
        }
      }
    } else {
      console.log('Key does not appear to be in PEM format');
    }
  }
  
  // Test SSH connection
  console.log('\nTesting SSH connection...');
  
  try {
    execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes -i "${keyPath}" ${username}@${host} "echo SSH connection successful"`, {
      stdio: 'pipe'
    });
    console.log('✅ SSH connection successful!');
  } catch (error) {
    console.error(`❌ SSH connection failed: ${error.message}`);
    
    // Try to diagnose the issue
    console.log('\nAttempting to diagnose the issue...');
    
    // Check DNS resolution
    try {
      console.log(`Checking DNS resolution for ${host}...`);
      execSync(`ping -c 1 ${host}`, { stdio: 'pipe' });
      console.log('✅ Host is reachable via ping');
    } catch (pingError) {
      console.log('⚠️ Host did not respond to ping (this may be normal due to firewall rules)');
    }
    
    // Check if SSH port is open
    try {
      console.log('Checking if SSH port (22) is open...');
      execSync(`nc -zv -w5 ${host} 22`, { stdio: 'pipe' });
      console.log('✅ SSH port is open');
    } catch (ncError) {
      console.log('❌ SSH port appears to be closed or blocked');
      console.log('Please check your security group rules to ensure port 22 is open');
    }
    
    // Check verbose SSH output
    console.log('\nRunning verbose SSH connection test...');
    
    try {
      const cmd = `ssh -vvv -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "${keyPath}" ${username}@${host} "echo test"`;
      execSync(cmd, { stdio: 'inherit' });
    } catch (error) {
      console.log('SSH connection with verbose logging failed');
    }
    
    // Provide recommendations
    console.log('\nRecommendations:');
    console.log('1. Check that your EC2 instance is running');
    console.log('2. Verify security group allows SSH on port 22 from your IP');
    console.log('3. Confirm the SSH key is correctly associated with the instance');
    console.log('4. Try connecting through the AWS console session manager if available');
    
    // Offer to create a new key
    const createNewKey = await prompt('\nWould you like to create a new SSH key for testing? (y/n): ');
    
    if (createNewKey.toLowerCase() === 'y') {
      const newKeyName = `lightci-recovery-${Date.now()}`;
      const newKeyPath = path.join(sshDir, newKeyName);
      
      console.log(`Creating new SSH key at ${newKeyPath}...`);
      
      try {
        execSync(`ssh-keygen -t rsa -b 2048 -f "${newKeyPath}" -N ""`, { stdio: 'inherit' });
        console.log(`✅ New key created at ${newKeyPath}`);
        console.log(`✅ Public key created at ${newKeyPath}.pub`);
        
        // Display the public key
        const pubKey = fs.readFileSync(`${newKeyPath}.pub`, 'utf8');
        console.log('\nTo use this key with your instance, you need to add this public key to ~/.ssh/authorized_keys on the instance:');
        console.log('\n' + pubKey);
        
        console.log('\nIf you have access to the instance through the AWS console or another key, you can run:');
        console.log(`echo "${pubKey}" >> ~/.ssh/authorized_keys`);
      } catch (keygenError) {
        console.error(`Error creating new key: ${keygenError.message}`);
      }
    }
  }
  
  rl.close();
}

main().catch(error => {
  console.error('Error:', error);
  rl.close();
  process.exit(1);
}); 