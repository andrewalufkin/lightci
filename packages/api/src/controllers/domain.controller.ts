import type { Request, Response } from 'express-serve-static-core';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { prisma } from '../db.js';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

/**
 * Add a custom domain to an app
 */
export async function addDomain(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { appId } = req.params;
    const { domain, domainType = 'custom' } = req.body;
    
    // Validate input
    if (!domain) {
      res.status(400).json({ error: 'Domain is required' });
      return;
    }
    
    // Check if domain already exists for this app
    const existingDomain = await prisma.domain.findFirst({
      where: {
        deployedAppId: appId,
        domain
      }
    });
    
    if (existingDomain) {
      res.status(400).json({ error: 'Domain already exists for this app' });
      return;
    }
    
    // Get the deployed app details to check ownership
    const deployedApp = await prisma.deployedApp.findUnique({
      where: { id: appId },
      include: {
        pipeline: true
      }
    });
    
    if (!deployedApp) {
      res.status(404).json({ error: 'Deployed app not found' });
      return;
    }
    
    // Check if the user owns this app's pipeline
    if (deployedApp.pipeline.createdById !== req.user.id) {
      res.status(403).json({ error: 'You do not have permission to add domains to this app' });
      return;
    }
    
    // Generate verification token
    const verifyToken = randomUUID();
    
    // Create the domain record
    const newDomain = await prisma.domain.create({
      data: {
        domain,
        domainType,
        verified: false,
        status: 'pending_verification',
        verifyToken,
        deployedAppId: appId
      }
    });
    
    // Ensure the deployment configuration has proper SSH credentials for the domain setup
    await ensureDeploymentConfigPreserved(deployedApp.pipelineId);
    
    res.status(201).json({
      id: newDomain.id,
      domain: newDomain.domain,
      domainType: newDomain.domainType,
      verified: newDomain.verified,
      status: newDomain.status,
      verifyToken: newDomain.verifyToken
    });
  } catch (error) {
    console.error(`[DomainController] Error adding domain:`, error);
    res.status(500).json({ error: 'Failed to add domain' });
  }
}

/**
 * Helper function to safely clone config with SSH keys preserved
 */
function safeCloneConfig(config: any): any {
  if (!config) return config;
  
  // First preserve SSH keys
  const sshKey = config.ec2SshKey || '';
  const encodedKey = config.ec2SshKeyEncoded || '';
  
  // Make a copy without SSH keys
  const configWithoutKeys = { ...config };
  delete configWithoutKeys.ec2SshKey;
  delete configWithoutKeys.ec2SshKeyEncoded;
  
  // Deep clone everything except SSH keys
  const cloned = JSON.parse(JSON.stringify(configWithoutKeys));
  
  // Re-add SSH keys directly
  if (sshKey) {
    cloned.ec2SshKey = sshKey;
    console.log('[DomainController] Preserved SSH key in config clone');
    
    // Also ensure it's in the config object for backwards compatibility
    if (cloned.config) {
      cloned.config.ec2SshKey = sshKey;
    }
  }
  
  if (encodedKey) {
    cloned.ec2SshKeyEncoded = encodedKey;
    console.log('[DomainController] Preserved encoded SSH key in config clone');
    
    // Also ensure it's in the config object for backwards compatibility
    if (cloned.config) {
      cloned.config.ec2SshKeyEncoded = encodedKey;
    }
  } else if (sshKey) {
    // If we have a sshKey but no encodedKey, create the encoded version
    try {
      const newEncodedKey = Buffer.from(sshKey).toString('base64');
      cloned.ec2SshKeyEncoded = newEncodedKey;
      console.log('[DomainController] Created encoded SSH key in config clone');
      
      // Also add to config nested object
      if (cloned.config) {
        cloned.config.ec2SshKeyEncoded = newEncodedKey;
      }
    } catch (encodeError) {
      console.error('[DomainController] Error encoding SSH key:', encodeError);
    }
  }
  
  return cloned;
}

/**
 * Helper method to ensure deployment config is preserved 
 * This is critical for maintaining SSH keys
 */
async function ensureDeploymentConfigPreserved(pipelineId: string): Promise<void> {
  try {
    console.log(`[DomainController] Preserving deployment config for pipeline ${pipelineId}`);
    
    // Get current pipeline config
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: pipelineId }
    });
    
    if (!pipeline) {
      console.error(`[DomainController] Pipeline ${pipelineId} not found for configuration preservation`);
      return;
    }
    
    // No need to modify if deployment config doesn't exist
    if (!pipeline.deploymentConfig) {
      console.log(`[DomainController] No deployment config exists for pipeline ${pipelineId}`);
      return;
    }
    
    // Parse the deployment config
    let deploymentConfig: any;
    try {
      deploymentConfig = typeof pipeline.deploymentConfig === 'string'
        ? JSON.parse(pipeline.deploymentConfig)
        : pipeline.deploymentConfig;
      
      console.log(`[DomainController] Successfully parsed deployment config for pipeline ${pipelineId}`);
    } catch (error) {
      console.error(`[DomainController] Error parsing deployment config:`, error);
      return;
    }
    
    // Ensure SSH keys are consistent and properly formatted
    let sshKeyUpdated = false;
    
    // Make sure we have EC2 SSH key if platform is AWS EC2
    if (pipeline.deploymentPlatform === 'aws_ec2' && 
        deploymentConfig && 
        !deploymentConfig.ec2SshKey && 
        deploymentConfig.config && 
        deploymentConfig.config.ec2SshKey) {
      
      console.log(`[DomainController] SSH key found in config.ec2SshKey, copying to top level`);
      
      // Store SSH key state for logging
      const originalKeyLength = deploymentConfig.config.ec2SshKey.length;
      const keyStartsWithBegin = deploymentConfig.config.ec2SshKey.trim().startsWith('-----BEGIN');
      
      // Don't use JSON.stringify/parse with SSH keys as it can corrupt them
      // Instead, directly copy the key
      deploymentConfig.ec2SshKey = deploymentConfig.config.ec2SshKey;
      sshKeyUpdated = true;
      
      // Add proper PEM formatting if needed
      const sshKey = deploymentConfig.ec2SshKey;
      if (keyStartsWithBegin) {
        // Check if key already has proper PEM format with line breaks
        const keyLines = sshKey.split(/\r?\n/).filter(line => line.trim() !== '');
        const hasProperFormat = keyLines.length > 2;
        
        if (!hasProperFormat) {
          console.log(`[DomainController] SSH key doesn't have proper PEM format with line breaks, reformatting`);
          
          // Extract begin and end headers
          const beginMatch = sshKey.match(/(-----BEGIN [^-]+ -----)/);
          const endMatch = sshKey.match(/(-----END [^-]+ -----)/);
          
          if (beginMatch && endMatch) {
            const beginHeader = beginMatch[1];
            const endHeader = endMatch[1];
            
            // Clean all whitespace from content to ensure consistent parsing
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
            const formattedKey = [
              beginHeader,
              ...contentLines,
              endHeader
            ].join('\n');
            
            // Update with properly formatted key
            deploymentConfig.ec2SshKey = formattedKey;
            
            console.log(`[DomainController] Reformatted SSH key to proper PEM format with ${contentLines.length + 2} lines`);
            sshKeyUpdated = true;
          }
        }
      }
      
      // Always encode for backup purposes
      try {
        const encodedKey = Buffer.from(deploymentConfig.ec2SshKey).toString('base64');
        deploymentConfig.ec2SshKeyEncoded = encodedKey;
        console.log(`[DomainController] SSH key encoded successfully. Original length: ${originalKeyLength}, Encoded length: ${encodedKey.length}`);
        sshKeyUpdated = true;
        
        // Also ensure the key is in the config object for backward compatibility
        deploymentConfig.config.ec2SshKeyEncoded = encodedKey;
      } catch (encodeError) {
        console.error(`[DomainController] Error encoding SSH key:`, encodeError);
      }
      
      // Also ensure the key is preserved in the config object for backward compatibility
      deploymentConfig.config.ec2SshKey = deploymentConfig.ec2SshKey;
    }
    // Check if we already have a top-level SSH key
    else if (deploymentConfig.ec2SshKey) {
      console.log(`[DomainController] Pipeline ${pipelineId} already has a top-level SSH key`);
      
      // Validate SSH key format and reformat if needed
      const sshKey = deploymentConfig.ec2SshKey;
      if (sshKey.trim().startsWith('-----BEGIN')) {
        const keyLines = sshKey.split(/\r?\n/).filter(line => line.trim() !== '');
        const hasProperFormat = keyLines.length > 2;
        
        if (!hasProperFormat) {
          console.log(`[DomainController] Existing SSH key doesn't have proper PEM format, reformatting`);
          
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
            const formattedKey = [
              beginHeader,
              ...contentLines,
              endHeader
            ].join('\n');
            
            // Update with properly formatted key
            deploymentConfig.ec2SshKey = formattedKey;
            
            console.log(`[DomainController] Reformatted existing SSH key to proper PEM format with ${contentLines.length + 2} lines`);
            sshKeyUpdated = true;
            
            // Also preserve in config.ec2SshKey for backward compatibility
            if (deploymentConfig.config) {
              deploymentConfig.config.ec2SshKey = formattedKey;
            }
          }
        }
      }
      
      // Make sure we also have encoded key for consistency
      try {
        deploymentConfig.ec2SshKeyEncoded = Buffer.from(deploymentConfig.ec2SshKey).toString('base64');
        console.log(`[DomainController] Added/updated encoded SSH key (${deploymentConfig.ec2SshKeyEncoded.length} chars)`);
        sshKeyUpdated = true;
        
        // Also preserve in config object
        if (deploymentConfig.config) {
          deploymentConfig.config.ec2SshKeyEncoded = deploymentConfig.ec2SshKeyEncoded;
        }
      } catch (error) {
        console.error(`[DomainController] Error updating config with encoded SSH key:`, error);
      }
    } else {
      console.log(`[DomainController] Pipeline ${pipelineId} has no SSH key in deployment config`);
    }
    
    // Only update the database if we made changes to the SSH key
    if (sshKeyUpdated) {
      // Update config with special handling for SSH key using our safe clone method
      const safeConfig = safeCloneConfig(deploymentConfig);
      
      // Update the database
      try {
        await prisma.pipeline.update({
          where: { id: pipelineId },
          data: {
            deploymentConfig: JSON.stringify(safeConfig)
          }
        });
        
        console.log(`[DomainController] Updated pipeline ${pipelineId} with preserved SSH key configuration`);
      } catch (updateError) {
        console.error(`[DomainController] Error updating pipeline with preserved SSH key:`, updateError);
      }
    } else {
      console.log(`[DomainController] No SSH key changes needed for pipeline ${pipelineId}`);
    }
  } catch (error) {
    console.error(`[DomainController] Error preserving deployment config:`, error);
    // Don't throw error to caller, just log it
  }
}

// Check for verified domains using raw query to avoid type issues
const domainsQuery = await prisma.$queryRaw`
  SELECT * FROM domains
  WHERE deployed_app_id = ${deployedApp.id}
    AND verified = true
    AND status = 'active'
`;

// Cast the result to the expected type
const domains = domainsQuery as unknown as { id: string; domain: string; verify_token: string }[]; 