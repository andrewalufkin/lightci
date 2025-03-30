#!/usr/bin/env node
// mock_dns_verify.js
// A tool to simulate DNS TXT record verification for domain testing

const axios = require('axios');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:3001/api';
const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  console.error('\x1b[31mError: Please set TOKEN environment variable\x1b[0m');
  process.exit(1);
}

// HTTP client with auth
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  }
});

// Mock DNS verification by directly patching the domain record
async function mockVerifyDomain(domainId) {
  try {
    console.log(`\x1b[34m[INFO]\x1b[0m Simulating DNS verification for domain ID: ${domainId}`);
    
    // In a real implementation, this would check a DNS TXT record
    // For testing, we just mark the domain as verified
    const response = await api.post(`/domains/${domainId}/verify`, {
      _mock_verification: true // This is a custom flag for testing
    });
    
    console.log(`\x1b[32m[SUCCESS]\x1b[0m Domain verification simulated`);
    console.log(JSON.stringify(response.data, null, 2));
    
    return response.data;
  } catch (error) {
    console.error(`\x1b[31m[ERROR]\x1b[0m Failed to simulate verification: ${error.message}`);
    if (error.response) {
      console.error(JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

// List domains for a deployed app
async function listDomains(deployedAppId) {
  try {
    console.log(`\x1b[34m[INFO]\x1b[0m Fetching domains for app: ${deployedAppId}`);
    
    const response = await api.get(`/domains/app/${deployedAppId}`);
    const { domains } = response.data;
    
    console.log(`\x1b[32m[SUCCESS]\x1b[0m Found ${domains.length} domains`);
    
    if (domains.length === 0) {
      console.log('No domains found for this app');
      return [];
    }
    
    console.log('\nAvailable domains:');
    domains.forEach((domain, index) => {
      const verifiedStatus = domain.verified ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`${index + 1}. ${domain.domain} [${verifiedStatus}] - Status: ${domain.status} - ID: ${domain.id}`);
      if (!domain.verified && domain.verifyToken) {
        console.log(`   Verification token: ${domain.verifyToken}`);
      }
    });
    
    return domains;
  } catch (error) {
    console.error(`\x1b[31m[ERROR]\x1b[0m Failed to list domains: ${error.message}`);
    if (error.response) {
      console.error(JSON.stringify(error.response.data, null, 2));
    }
    return [];
  }
}

// Interactive CLI
async function startCLI() {
  console.log('\x1b[35m==============================================\x1b[0m');
  console.log('\x1b[35m   Domain Verification Testing Tool  \x1b[0m');
  console.log('\x1b[35m==============================================\x1b[0m\n');
  
  rl.question('Enter deployed app ID: ', async (deployedAppId) => {
    if (!deployedAppId) {
      console.error('\x1b[31mError: Deployed app ID is required\x1b[0m');
      rl.close();
      return;
    }
    
    try {
      const domains = await listDomains(deployedAppId);
      
      if (domains.length === 0) {
        console.log('\nNo domains to verify. Please add a domain first.');
        rl.close();
        return;
      }
      
      rl.question('\nEnter domain number to verify (or q to quit): ', async (answer) => {
        if (answer.toLowerCase() === 'q') {
          rl.close();
          return;
        }
        
        const index = parseInt(answer) - 1;
        if (isNaN(index) || index < 0 || index >= domains.length) {
          console.error('\x1b[31mInvalid selection\x1b[0m');
          rl.close();
          return;
        }
        
        const selectedDomain = domains[index];
        
        if (selectedDomain.verified) {
          console.log('\x1b[33m[WARNING]\x1b[0m This domain is already verified');
          rl.question('Proceed anyway? (y/n): ', async (confirm) => {
            if (confirm.toLowerCase() === 'y') {
              await mockVerifyDomain(selectedDomain.id);
            }
            rl.close();
          });
        } else {
          await mockVerifyDomain(selectedDomain.id);
          rl.close();
        }
      });
    } catch (error) {
      console.error('\x1b[31mOperation failed\x1b[0m');
      rl.close();
    }
  });
}

// Start the CLI
startCLI(); 