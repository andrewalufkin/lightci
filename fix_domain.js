#!/usr/bin/env node
// fix_domain.js - A script to diagnose and fix domain issues

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Configuration (these values will need to be updated)
const domain = 'andrewbadams.com';
const ec2InstanceIp = '44.202.162.30';
const keyPath = '/path/to/your/keypair.pem'; // Update this path
const username = 'ec2-user';
const port = 3000; // Your app port

// Helper to execute SSH commands
function runSSHCommand(cmd) {
  try {
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -i "${keyPath}" ${username}@${ec2InstanceIp} "${cmd}"`;
    console.log(`\n→ Running: ${cmd}`);
    const output = execSync(sshCmd, { encoding: 'utf8' });
    console.log(output);
    return { success: true, output };
  } catch (error) {
    console.error(`Error executing command: ${error.message}`);
    if (error.stdout) console.log('STDOUT:', error.stdout);
    if (error.stderr) console.error('STDERR:', error.stderr);
    return { success: false, error };
  }
}

async function main() {
  console.log(`\n===== Domain Connection Troubleshooter =====`);
  console.log(`Domain: ${domain}`);
  console.log(`EC2 Instance: ${ec2InstanceIp}`);
  
  // Check 1: Verify Nginx is installed and running
  console.log('\n== Checking Nginx status ==');
  runSSHCommand('sudo systemctl status nginx');
  
  // Check 2: Examine Nginx configuration
  console.log('\n== Checking Nginx configuration ==');
  runSSHCommand(`sudo ls -la /etc/nginx/conf.d/`);
  runSSHCommand(`sudo cat /etc/nginx/conf.d/${domain}.conf || echo "Domain config not found"`);
  
  // Check 3: Validate Nginx configuration
  console.log('\n== Validating Nginx configuration ==');
  runSSHCommand('sudo nginx -t');
  
  // Check 4: Check application status
  console.log('\n== Checking application status ==');
  runSSHCommand(`ps aux | grep -v grep | grep -i 'node\\|npm\\|pm2'`);
  runSSHCommand(`netstat -tulpn | grep :${port} || echo "No process is listening on port ${port}"`);
  
  // Check 5: Check application logs
  console.log('\n== Checking application logs ==');
  runSSHCommand('cd ~/app && ls -la');
  runSSHCommand('cd ~/app && cat logs/app.log 2>/dev/null || echo "No app logs found"');
  
  // Check 6: Check Nginx logs
  console.log('\n== Checking Nginx logs ==');
  runSSHCommand(`sudo tail -n 20 /var/log/nginx/${domain}-error.log 2>/dev/null || echo "No Nginx error logs found"`);
  
  // Fix 1: Restart Nginx
  console.log('\n== Restarting Nginx ==');
  runSSHCommand('sudo systemctl restart nginx');
  
  // Fix 2: Ensure application is running
  console.log('\n== Ensuring application is running ==');
  runSSHCommand(`cd ~/app && (pm2 list || echo "PM2 not found")`);
  const startAppResult = runSSHCommand(`cd ~/app && (pm2 restart all || npm start) || echo "Failed to start application"`);
  
  console.log('\n===== Troubleshooting Complete =====');
  console.log('Check the output above for errors or issues.');
  console.log(`Try accessing your domain again: http://${domain}`);
  console.log('\nIf your domain is still not working, consider the following:');
  console.log('1. Ensure your security group allows traffic on port 80 and 443');
  console.log('2. Verify your application is properly configured for production');
  console.log('3. Check that your DNS settings are correct (A record points to EC2 IP)');
  console.log('4. Try rebuilding and redeploying your application');
}

main().catch(console.error); 