import { Router } from 'express';
import { DeploymentService } from '../services/deployment.service.js';
import { PrismaClient } from '@prisma/client';
import { authenticate } from '../middleware/auth.middleware.js';
import { AuthenticatedRequest } from '../types/auth.js';

const router = Router();
const prisma = new PrismaClient();

// Create a deployment service instance
// We're not using engineService directly, so we can pass null
// @ts-ignore - Ignoring type mismatch for engine service
const deploymentService = new DeploymentService(null);

// ... rest of the file unchanged ...

// Add endpoint to configure a domain after verification
router.post('/configure-domain', authenticate, async (req, res) => {
  try {
    // Validate input
    const { deployedApp, domain, deploymentConfig, pipelineId } = req.body;
    
    if (!deployedApp || !domain || !deploymentConfig) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Check authorization
    // Get the pipeline to verify ownership
    const pipeline = await prisma.pipeline.findUnique({
      where: { id: pipelineId },
      select: { createdById: true }
    });
    
    if (!pipeline) {
      return res.status(404).json({ error: 'Pipeline not found' });
    }
    
    // Only allow the pipeline owner or internal API calls to configure domains
    const isInternalRequest = req.headers.authorization?.startsWith('internal ') && 
      req.headers.authorization.split(' ')[1] === process.env.INTERNAL_API_SECRET;
      
    if (!isInternalRequest && pipeline.createdById !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to configure domains for this app' });
    }
    
    // Use the existing deployment service instance
    // Add a log for debugging
    console.log(`[Deployment] Configuring domain ${domain.domain} for app ${deployedApp.id}`);
    
    // Call the domain configuration method
    try {
      // Get the config properly set up
      const config = {
        ...deploymentConfig,
        pipelineId
      };
      
      // Call the public method that we added to configure domains
      const result = await deploymentService.configureDomainAfterVerification(
        deployedApp,
        domain,
        config
      );
      
      if (result.success) {
        return res.json(result);
      } else {
        return res.status(500).json(result);
      }
    } catch (configError) {
      console.error('[Deployment] Error in domain configuration:', configError);
      return res.status(500).json({ 
        error: 'Failed to configure domain',
        details: configError.message
      });
    }
  } catch (error) {
    console.error('[Deployment] Error handling domain configuration:', error);
    return res.status(500).json({ error: 'Failed to process domain configuration request' });
  }
});

// ... rest of the file unchanged ... 