import { prisma } from '../lib/prisma.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * Helper function to safely clone config with SSH keys preserved
 */
export function safeCloneConfig(config: any): any {
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
    console.log('[SSH-Helpers] Preserved SSH key in config clone');
    
    // Also ensure it's in the config object for backwards compatibility
    if (cloned.config) {
      cloned.config.ec2SshKey = sshKey;
    }
  }
  
  if (encodedKey) {
    cloned.ec2SshKeyEncoded = encodedKey;
    console.log('[SSH-Helpers] Preserved encoded SSH key in config clone');
    
    // Also ensure it's in the config object for backwards compatibility
    if (cloned.config) {
      cloned.config.ec2SshKeyEncoded = encodedKey;
    }
  } else if (sshKey) {
    // If we have a sshKey but no encodedKey, create the encoded version
    try {
      const newEncodedKey = Buffer.from(sshKey).toString('base64');
      cloned.ec2SshKeyEncoded = newEncodedKey;
      console.log('[SSH-Helpers] Created encoded SSH key in config clone');
      
      // Also add to config nested object
      if (cloned.config) {
        cloned.config.ec2SshKeyEncoded = newEncodedKey;
      }
    } catch (encodeError) {
      console.error('[SSH-Helpers] Error encoding SSH key:', encodeError);
    }
  }
  
  return cloned;
}

/**
 * Helper function to repair a corrupted SSH key
 */
export async function repairKey(keyContent: string): Promise<string | null> {
  if (!keyContent) return null;
  
  // 1. Check for PEM format
  const hasPemBegin = keyContent.includes('-----BEGIN');
  const hasPemEnd = keyContent.includes('-----END');
  
  if (!hasPemBegin || !hasPemEnd) {
    console.log(`[SSH-Helpers] Key doesn't have proper BEGIN/END markers`);
    return null;
  }
  
  // 2. Extract and reformat content
  const beginMatch = keyContent.match(/(-----BEGIN [^-]+ -----)/);
  const endMatch = keyContent.match(/(-----END [^-]+ -----)/);
  
  if (!beginMatch || !endMatch) {
    console.log(`[SSH-Helpers] Couldn't find proper BEGIN/END headers`);
    return null;
  }
  
  const beginHeader = beginMatch[1];
  const endHeader = endMatch[1];
  
  // Extract content between headers, cleaning all whitespace
  let content = keyContent.substring(
    keyContent.indexOf(beginHeader) + beginHeader.length,
    keyContent.indexOf(endHeader)
  ).replace(/\s+/g, '');
  
  // Format into proper 64-char lines
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
  
  return formattedKey;
}

/**
 * Helper method to ensure deployment config is preserved 
 * This is critical for maintaining SSH keys
 */
export async function ensureDeploymentConfigPreserved(pipelineId: string): Promise<void> {
  try {
    console.log(`[SSH-Helpers] Preserving deployment config for pipeline ${pipelineId}`);
    
    // Get current pipeline config
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: pipelineId }
    });
    
    if (!pipeline) {
      console.error(`[SSH-Helpers] Pipeline ${pipelineId} not found for configuration preservation`);
      return;
    }
    
    // No need to modify if deployment config doesn't exist
    if (!pipeline.deploymentConfig) {
      console.log(`[SSH-Helpers] No deployment config exists for pipeline ${pipelineId}`);
      return;
    }
    
    // Parse the deployment config
    let deploymentConfig: any;
    try {
      deploymentConfig = typeof pipeline.deploymentConfig === 'string'
        ? JSON.parse(pipeline.deploymentConfig)
        : pipeline.deploymentConfig;
      
      console.log(`[SSH-Helpers] Successfully parsed deployment config for pipeline ${pipelineId}`);
    } catch (error) {
      console.error(`[SSH-Helpers] Error parsing deployment config:`, error);
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
      
      console.log(`[SSH-Helpers] SSH key found in config.ec2SshKey, copying to top level`);
      
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
          console.log(`[SSH-Helpers] SSH key doesn't have proper PEM format with line breaks, reformatting`);
          
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
            
            console.log(`[SSH-Helpers] Reformatted SSH key to proper PEM format with ${contentLines.length + 2} lines`);
            sshKeyUpdated = true;
          }
        }
      }
      
      // Always encode for backup purposes
      try {
        const encodedKey = Buffer.from(deploymentConfig.ec2SshKey).toString('base64');
        deploymentConfig.ec2SshKeyEncoded = encodedKey;
        console.log(`[SSH-Helpers] SSH key encoded successfully. Original length: ${originalKeyLength}, Encoded length: ${encodedKey.length}`);
        sshKeyUpdated = true;
      } catch (encodeError) {
        console.error(`[SSH-Helpers] Error encoding SSH key:`, encodeError);
      }
    }
    // Check if we already have a top-level SSH key
    else if (deploymentConfig.ec2SshKey) {
      console.log(`[SSH-Helpers] Pipeline ${pipelineId} already has a top-level SSH key`);
      
      // Validate SSH key format and reformat if needed
      const sshKey = deploymentConfig.ec2SshKey;
      if (sshKey.trim().startsWith('-----BEGIN')) {
        const keyLines = sshKey.split(/\r?\n/).filter(line => line.trim() !== '');
        const hasProperFormat = keyLines.length > 2;
        
        if (!hasProperFormat) {
          console.log(`[SSH-Helpers] Existing SSH key doesn't have proper PEM format, reformatting`);
          
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
            
            console.log(`[SSH-Helpers] Reformatted existing SSH key to proper PEM format with ${contentLines.length + 2} lines`);
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
        console.log(`[SSH-Helpers] Added/updated encoded SSH key (${deploymentConfig.ec2SshKeyEncoded.length} chars)`);
        sshKeyUpdated = true;
        
        // Also preserve in config object
        if (deploymentConfig.config) {
          deploymentConfig.config.ec2SshKeyEncoded = deploymentConfig.ec2SshKeyEncoded;
        }
      } catch (error) {
        console.error(`[SSH-Helpers] Error updating config with encoded SSH key:`, error);
      }
    }
    
    // If we have encoded key but no main key, try to restore from encoded
    if (!deploymentConfig.ec2SshKey && deploymentConfig.ec2SshKeyEncoded) {
      try {
        deploymentConfig.ec2SshKey = Buffer.from(deploymentConfig.ec2SshKeyEncoded, 'base64').toString('utf8');
        console.log(`[SSH-Helpers] Restored SSH key from encoded value (${deploymentConfig.ec2SshKey.length} chars)`);
        sshKeyUpdated = true;
        
        // Also store in config object for backward compatibility
        if (deploymentConfig.config) {
          deploymentConfig.config.ec2SshKey = deploymentConfig.ec2SshKey;
        }
      } catch (decodeError) {
        console.error(`[SSH-Helpers] Error decoding SSH key:`, decodeError);
      }
    }
    
    // Skip update if nothing changed
    if (!sshKeyUpdated) {
      console.log(`[SSH-Helpers] No SSH key changes needed for pipeline ${pipelineId}`);
      return;
    }
    
    // Save the updated deployment config back to the database
    await prisma.pipeline.update({
      where: { id: pipelineId },
      data: {
        deploymentConfig: typeof pipeline.deploymentConfig === 'string'
          ? JSON.stringify(deploymentConfig)
          : deploymentConfig
      }
    });
    
    console.log(`[SSH-Helpers] Successfully updated deployment config with preserved SSH keys for pipeline ${pipelineId}`);
  } catch (error: any) {
    console.error(`[SSH-Helpers] Error preserving deployment config: ${error.message}`);
  }
}

/**
 * Helper function to verify an SSH key against an instance
 */
export async function verifySSHKey(keyPath: string, user: string, host: string): Promise<boolean> {
  try {
    console.log(`[SSH-Helpers] Verifying SSH key at ${keyPath} for ${user}@${host}`);
    
    // Ensure key has proper permissions
    try {
      fs.chmodSync(keyPath, 0o600);
    } catch (chmodError) {
      console.error(`[SSH-Helpers] Error setting key permissions: ${chmodError}`);
    }
    
    // Try a simple SSH connection
    const result = execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes -i "${keyPath}" ${user}@${host} "echo Key verification successful"`,
      { timeout: 10000, encoding: 'utf8' }
    );
    
    console.log(`[SSH-Helpers] SSH key verification result: ${result.trim()}`);
    return true;
  } catch (error: any) {
    console.error(`[SSH-Helpers] SSH key verification failed: ${error.message}`);
    return false;
  }
} 