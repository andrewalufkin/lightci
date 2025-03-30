import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middleware/auth.middleware.js';
import * as crypto from 'crypto';
import * as dns from 'dns';
import { promisify } from 'util';
import fetch from 'node-fetch';

// Import the deployment config preservation function
import { ensureDeploymentConfigPreserved } from '../utils/ssh-helpers.js';
// Import DeploymentService for domain configuration
import { DeploymentService } from '../services/deployment.service.js';

// Configure DNS settings
dns.setDefaultResultOrder('ipv4first');
// Set a longer timeout for DNS resolution (default is 5 seconds)
dns.setServers([...dns.getServers(), '8.8.8.8', '1.1.1.1']);

const resolveTxt = promisify(dns.resolveTxt);

// Helper function to retry DNS resolution with timeout
const resolveTxtWithRetry = async (domain: string, maxRetries = 3) => {
  console.log(`[DNS] Attempting to resolve TXT records for ${domain} with ${maxRetries} retries`);
  console.log(`[DNS] Using DNS servers: ${dns.getServers().join(', ')}`);
  
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[DNS] Attempt ${attempt}/${maxRetries} to resolve TXT records for ${domain}`);
      const records = await resolveTxt(domain);
      console.log(`[DNS] Success! Found ${records.length} TXT records for ${domain}`);
      console.log(`[DNS] TXT Records:`, JSON.stringify(records));
      return records;
    } catch (error) {
      lastError = error;
      console.error(`[DNS] Attempt ${attempt}/${maxRetries} failed:`, error);
      if (attempt < maxRetries) {
        // Wait before retrying (increasing delay with each attempt)
        const delay = attempt * 1000;
        console.log(`[DNS] Waiting ${delay}ms before next attempt...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // All retries failed
  throw lastError;
};

const router = Router();

// Helper function to transform domain fields to camelCase
const transformDomainToCamelCase = (domain: any) => {
  return {
    id: domain.id,
    domain: domain.domain,
    verified: domain.verified,
    status: domain.status,
    verifyToken: domain.verify_token,
    deployedAppId: domain.deployed_app_id,
    createdAt: domain.created_at,
    updatedAt: domain.updated_at,
    created_by: domain.created_by
  };
};

// Define interface for domain with additional app fields
interface EnhancedDomain {
  id: string;
  domain: string;
  verified: boolean;
  status: string;
  verify_token: string;
  deployed_app_id: string;
  created_at: Date;
  updated_at: Date;
  created_by?: string;
  pipeline_id?: string;
  app_url?: string;
  app_name?: string;
}

// Schema for adding a new domain
const addDomainSchema = z.object({
  domain: z.string().min(3).refine((val) => {
    // Basic domain validation
    return /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(val);
  }, { message: "Please enter a valid domain name" }),
  deployedAppId: z.string().uuid()
});

// Domain type
interface Domain {
  id: string;
  domain: string;
  verified: boolean;
  status: string;
  verify_token: string;
  deployed_app_id: string;
  created_at: Date;
  updated_at: Date;
  created_by?: string;
  pipeline_id?: string;
}

// Get all domains for a deployed app
router.get('/app/:deployedAppId', authenticate, async (req, res) => {
  try {
    const { deployedAppId } = req.params;

    // Verify ownership
    const deployedApp = await prisma.deployedApp.findUnique({
      where: { id: deployedAppId },
      include: {
        pipeline: {
          select: { createdById: true }
        }
      }
    });

    if (!deployedApp) {
      return res.status(404).json({ error: 'Deployed app not found' });
    }

    if (deployedApp.pipeline.createdById !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to view these domains' });
    }

    const domains = await prisma.$queryRaw<Domain[]>`
      SELECT * FROM domains WHERE deployed_app_id = ${deployedAppId}
    `;

    return res.json({ domains: domains.map(transformDomainToCamelCase) });
  } catch (error) {
    console.error('Error fetching domains:', error);
    return res.status(500).json({ error: 'Failed to fetch domains' });
  }
});

// Add a new domain
router.post('/', authenticate, async (req, res) => {
  try {
    const { domain, deployedAppId } = addDomainSchema.parse(req.body);

    // Verify ownership
    const deployedApp = await prisma.deployedApp.findUnique({
      where: { id: deployedAppId },
      include: {
        pipeline: {
          select: { createdById: true }
        }
      }
    });

    if (!deployedApp) {
      return res.status(404).json({ error: 'Deployed app not found' });
    }

    if (deployedApp.pipeline.createdById !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to add domains to this app' });
    }

    // Check if domain already exists
    const existingDomain = await prisma.$queryRaw<Domain[]>`
      SELECT * FROM domains WHERE domain = ${domain} LIMIT 1
    `;

    if (existingDomain && existingDomain.length > 0) {
      return res.status(400).json({ error: 'Domain already registered' });
    }

    // Generate verification token
    const verifyToken = `lightci-verify=${crypto.randomBytes(16).toString('hex')}`;
    const domainId = crypto.randomUUID();

    // Create domain record
    await prisma.$executeRaw`
      INSERT INTO domains (id, domain, deployed_app_id, verify_token, created_at, updated_at)
      VALUES (${domainId}, ${domain}, ${deployedAppId}, ${verifyToken}, NOW(), NOW())
    `;

    // Get the newly created domain
    const [createdDomain] = await prisma.$queryRaw<Domain[]>`
      SELECT * FROM domains WHERE id = ${domainId} LIMIT 1
    `;

    res.status(201).json(transformDomainToCamelCase(createdDomain));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    console.error('Error adding domain:', error);
    return res.status(500).json({ error: 'Failed to add domain' });
  }
});

// Verify domain ownership via DNS TXT record
router.post('/:id/verify', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { _mock_verification } = req.body; // Add support for mock verification

    console.log(`[Domains] Verification request for domain ID: ${id}`);
    
    const [domain] = await prisma.$queryRaw<EnhancedDomain[]>`
      SELECT d.*, p.created_by, da.pipeline_id, da.id as deployed_app_id, da.name as app_name, da.url as app_url 
      FROM domains d
      JOIN deployed_apps da ON d.deployed_app_id = da.id
      JOIN pipelines p ON da.pipeline_id = p.id
      WHERE d.id = ${id}
      LIMIT 1
    `;

    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    console.log(`[Domains] Verifying domain: ${domain.domain}, Token: ${domain.verify_token}`);

    if (domain.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to verify this domain' });
    }

    // Preserve SSH keys in deployment config BEFORE verification
    await ensureDeploymentConfigPreserved(domain.pipeline_id);

    // Check if using mock verification for testing
    let verified = false;
    
    if (_mock_verification && process.env.NODE_ENV !== 'production') {
      console.log(`[TESTING] Using mock verification for domain ${domain.domain}`);
      verified = true;
    } else {
      // Regular DNS verification process
      try {
        // Use our enhanced DNS resolution function with retries
        const txtRecords = await resolveTxtWithRetry(domain.domain);
        const flatRecords = txtRecords.flat();
        console.log(`[Domains] Comparing TXT records:`, flatRecords);
        console.log(`[Domains] Looking for token:`, domain.verify_token);
        
        verified = flatRecords.some(record => {
          const match = record === domain.verify_token;
          console.log(`[Domains] Record: "${record}" ${match ? 'MATCHES' : 'does not match'} verification token`);
          return match;
        });
      } catch (dnsError) {
        console.error('[Domains] DNS resolution error:', dnsError);
        return res.json({
          success: false,
          message: 'Unable to resolve DNS records. Make sure your domain is properly configured.'
        });
      }
    }

    console.log(`[Domains] Verification result for ${domain.domain}: ${verified ? 'SUCCESS' : 'FAILED'}`);

    if (verified) {
      // Update domain status
      await prisma.$executeRaw`
        UPDATE domains
        SET verified = true, status = 'configuring', updated_at = NOW()
        WHERE id = ${id}
      `;

      const [updatedDomain] = await prisma.$queryRaw<Domain[]>`
        SELECT * FROM domains WHERE id = ${id}
      `;

      // Send an immediate response to the client that verification succeeded
      res.json({
        success: true,
        message: 'Domain verified successfully. Server configuration in progress...',
        domain: {
          id: updatedDomain.id,
          domain: updatedDomain.domain,
          status: updatedDomain.status,
          verified: updatedDomain.verified
        }
      });

      // Continue with the configuration asynchronously
      try {
        // Preserve SSH keys in deployment config AFTER verification too
        await ensureDeploymentConfigPreserved(domain.pipeline_id);

        // Get deployment configuration for configuring web server
        const pipeline = await prisma.pipeline.findUnique({
          where: { id: domain.pipeline_id },
          select: { deploymentConfig: true }
        });

        if (pipeline && pipeline.deploymentConfig) {
          try {
            // Parse deployment config
            let deploymentConfig;
            if (typeof pipeline.deploymentConfig === 'string') {
              deploymentConfig = JSON.parse(pipeline.deploymentConfig);
            } else {
              deploymentConfig = pipeline.deploymentConfig;
            }

            console.log(`[Domains] Requesting web server configuration for domain ${domain.domain}`);

            // Get the deployed app to pass to the configuration process
            const deployedApp = await prisma.deployedApp.findUnique({
              where: { id: domain.deployed_app_id }
            });

            if (deployedApp) {
              // Try to configure the domain, first directly, then via HTTP if needed
              try {
                console.log(`[Domains] Configuring domain ${domain.domain} for web server`);
                
                let configSuccess = false;
                
                // First attempt: Try direct configuration (more reliable)
                try {
                  // @ts-ignore - We're ignoring the type mismatch for engine service
                  const domainService = new DeploymentService(null);
                  
                  const directResult = await domainService.configureDomainAfterVerification(
                    {
                      id: deployedApp.id,
                      name: deployedApp.name,
                      url: deployedApp.url
                    },
                    {
                      id: updatedDomain.id,
                      domain: updatedDomain.domain,
                      verify_token: updatedDomain.verify_token
                    },
                    deploymentConfig
                  );
                  
                  if (directResult.success) {
                    console.log(`[Domains] Domain ${domain.domain} successfully configured via direct method`);
                    configSuccess = true;
                  } else {
                    console.log(`[Domains] Direct configuration failed: ${directResult.message}, trying HTTP method`);
                  }
                } catch (directError) {
                  console.log(`[Domains] Error in direct configuration, falling back to HTTP: ${directError.message}`);
                }
                
                // Second attempt: Try HTTP method if direct method failed
                if (!configSuccess) {
                  try {
                    // Use port 3000 (matching server.ts) instead of 3001
                    const configResponse = await fetch(`${process.env.API_BASE_URL || 'http://localhost:3000/api'}/deployment/configure-domain`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${req.user.token}`
                      },
                      body: JSON.stringify({
                        deployedApp: {
                          id: deployedApp.id,
                          name: deployedApp.name,
                          url: deployedApp.url
                        },
                        domain: {
                          id: updatedDomain.id,
                          domain: updatedDomain.domain,
                          verify_token: updatedDomain.verify_token
                        },
                        deploymentConfig,
                        pipelineId: domain.pipeline_id
                      })
                    });
                    
                    const configResult = await configResponse.json();
                    
                    if (configResult.success) {
                      console.log(`[Domains] Domain ${domain.domain} successfully configured via HTTP method`);
                      configSuccess = true;
                    } else {
                      console.error(`[Domains] HTTP configuration failed: ${configResult.message}`);
                    }
                  } catch (httpError) {
                    console.error(`[Domains] Error in HTTP configuration method: ${httpError.message}`);
                  }
                }
                
                if (!configSuccess) {
                  console.error(`[Domains] All configuration methods failed for domain ${domain.domain}`);
                }

                // After configuration completes successfully:
                if (configSuccess) {
                  await prisma.$executeRaw`
                    UPDATE domains
                    SET status = 'active', updated_at = NOW()
                    WHERE id = ${id}
                  `;
                  console.log(`[Domains] Domain ${domain.domain} status updated to active`);
                } else {
                  await prisma.$executeRaw`
                    UPDATE domains
                    SET status = 'configuration_failed', updated_at = NOW()
                    WHERE id = ${id}
                  `;
                  console.error(`[Domains] Domain ${domain.domain} configuration failed, status updated`);
                }
              } catch (configError) {
                console.error(`[Domains] Error in domain configuration: ${configError.message}`);
                await prisma.$executeRaw`
                  UPDATE domains
                  SET status = 'configuration_failed', updated_at = NOW()
                  WHERE id = ${id}
                `;
              }
            }
          } catch (configError) {
            console.error(`[Domains] Error in domain configuration: ${configError.message}`);
            await prisma.$executeRaw`
              UPDATE domains
              SET status = 'configuration_failed', updated_at = NOW()
              WHERE id = ${id}
            `;
          }
        } else {
          console.error(`[Domains] No deployment config found for pipeline ${domain.pipeline_id}`);
          await prisma.$executeRaw`
            UPDATE domains
            SET status = 'configuration_failed', updated_at = NOW()
            WHERE id = ${id}
          `;
        }
      } catch (asyncError) {
        console.error(`[Domains] Async error in domain configuration: ${asyncError.message}`);
        await prisma.$executeRaw`
          UPDATE domains
          SET status = 'configuration_failed', updated_at = NOW()
          WHERE id = ${id}
        `;
      }
    } else {
      return res.json({
        success: false,
        message: 'TXT record not found or does not match. Please add the TXT record and try again.'
      });
    }
  } catch (error) {
    console.error('Error verifying domain:', error);
    return res.status(500).json({ error: 'Failed to verify domain' });
  }
});

// Delete a domain
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const [domain] = await prisma.$queryRaw<Domain[]>`
      SELECT d.*, p.created_by, da.pipeline_id
      FROM domains d
      JOIN deployed_apps da ON d.deployed_app_id = da.id
      JOIN pipelines p ON da.pipeline_id = p.id
      WHERE d.id = ${id}
      LIMIT 1
    `;

    if (!domain) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    if (domain.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this domain' });
    }

    // Preserve SSH keys in deployment config BEFORE deletion
    await ensureDeploymentConfigPreserved(domain.pipeline_id);

    await prisma.$executeRaw`
      DELETE FROM domains WHERE id = ${id}
    `;

    // Preserve SSH keys in deployment config AFTER deletion too
    await ensureDeploymentConfigPreserved(domain.pipeline_id);

    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting domain:', error);
    return res.status(500).json({ error: 'Failed to delete domain' });
  }
});

export default router; 