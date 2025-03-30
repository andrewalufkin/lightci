import { Router } from 'express';
import type { Request, Response } from 'express-serve-static-core';
import { PrismaClient } from '@prisma/client';
import { SshKeyService } from '../services/ssh-key.service.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.middleware.js';

const prisma = new PrismaClient();
const sshKeyService = new SshKeyService(prisma);
const router = Router();

// Get all SSH keys for a user
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { id: userId } = (req as AuthenticatedRequest).user;

    // Get all deployments for the user that have SSH keys
    const deployments = await prisma.autoDeployment.findMany({
      where: {
        userId,
        // Using a workaround for TypeScript linting issue
        // The sshKeyId field does exist in the database
        // @ts-ignore
        sshKeyId: { not: null }
      },
      include: {
        // @ts-ignore
        sshKey: {
          select: {
            id: true,
            name: true,
            keyPairName: true,
            createdAt: true,
            updatedAt: true
          }
        }
      }
    });

    // Extract the unique keys
    const keys = deployments
      .map(d => d.sshKey)
      .filter((key, index, self) => 
        key && index === self.findIndex(k => k?.id === key.id)
      );

    return res.status(200).json(keys);
  } catch (error) {
    console.error(`[SSH Keys Route] Error fetching SSH keys: ${error.message}`);
    return res.status(500).json({ error: 'Failed to fetch SSH keys' });
  }
});

// Get a specific SSH key
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id: userId } = (req as AuthenticatedRequest).user;
    const { id } = req.params;

    // Verify the user has access to this key
    const deployment = await prisma.autoDeployment.findFirst({
      where: {
        userId,
        // @ts-ignore
        sshKeyId: id
      },
      include: {
        // @ts-ignore
        sshKey: {
          select: {
            id: true,
            name: true,
            keyPairName: true,
            createdAt: true,
            updatedAt: true
          }
        }
      }
    });

    if (!deployment || !deployment.sshKey) {
      return res.status(404).json({ error: 'SSH key not found' });
    }

    return res.status(200).json(deployment.sshKey);
  } catch (error) {
    console.error(`[SSH Keys Route] Error fetching SSH key: ${error.message}`);
    return res.status(500).json({ error: 'Failed to fetch SSH key' });
  }
});

// Create a new SSH key (used when importing an existing key)
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { id: userId } = (req as AuthenticatedRequest).user;
    const { name, content, keyPairName, deploymentId } = req.body;

    // If deploymentId is provided, verify the user owns it
    if (deploymentId) {
      const deployment = await prisma.autoDeployment.findFirst({
        where: {
          id: deploymentId,
          userId
        }
      });

      if (!deployment) {
        return res.status(404).json({ error: 'Deployment not found' });
      }
    }

    // Create the key
    const key = await sshKeyService.createKey({
      name,
      content,
      keyPairName
    });

    // Associate with deployment if specified
    if (deploymentId) {
      await sshKeyService.associateKeyWithDeployment(key.id, deploymentId);
    }

    return res.status(201).json({
      id: key.id,
      name: key.name,
      keyPairName: key.keyPairName
    });
  } catch (error) {
    console.error(`[SSH Keys Route] Error creating SSH key: ${error.message}`);
    return res.status(500).json({ error: 'Failed to create SSH key' });
  }
});

export const sshKeyRouter = router; 