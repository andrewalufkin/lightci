import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth.middleware';
import { InstanceProvisionerService } from '../services/instance-provisioner.service';

const listDeployedAppsQuerySchema = z.object({
  page: z.string().transform(Number).default('1'),
  limit: z.string().transform(Number).default('10'),
});

const router = Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const { page, limit } = listDeployedAppsQuerySchema.parse(req.query);
    const skip = (page - 1) * limit;

    // Get pipelines created by the user
    const userPipelines = await prisma.pipeline.findMany({
      where: {
        createdBy: { id: req.user.id }
      },
      select: {
        id: true
      }
    });

    const pipelineIds = userPipelines.map(p => p.id);

    const [apps, total] = await Promise.all([
      prisma.deployedApp.findMany({
        where: {
          pipelineId: {
            in: pipelineIds
          }
        },
        skip,
        take: limit,
        orderBy: { lastDeployed: 'desc' },
        include: {
          project: {
            select: {
              name: true,
            },
          },
        },
      }),
      prisma.deployedApp.count({
        where: {
          pipelineId: {
            in: pipelineIds
          }
        }
      }),
    ]);

    res.json({
      data: apps.map(app => ({
        id: app.id,
        name: app.name,
        url: app.url,
        status: app.status,
        lastDeployed: app.lastDeployed.toISOString(),
        projectId: app.projectId,
        pipelineId: app.pipelineId,
        environment: app.environment,
      })),
      pagination: {
        total,
        page,
        limit,
      },
    });
  } catch (error) {
    console.error('Error fetching deployed apps:', error);
    res.status(500).json({ error: 'Failed to fetch deployed apps' });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the deployed app and verify ownership
    const deployedApp = await prisma.deployedApp.findUnique({
      where: { id },
      include: {
        pipeline: {
          select: {
            createdById: true,
            deploymentConfig: true
          }
        }
      }
    });

    if (!deployedApp) {
      return res.status(404).json({ error: 'Deployed app not found' });
    }

    // Verify user owns the pipeline
    if (deployedApp.pipeline.createdById !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized to delete this deployment' });
    }

    // Get associated auto deployment
    const autoDeployment = await prisma.autoDeployment.findFirst({
      where: {
        pipelineId: deployedApp.pipelineId,
        status: 'active'
      }
    });

    if (autoDeployment) {
      // Initialize instance provisioner to terminate EC2 instance
      const deploymentConfig = deployedApp.pipeline.deploymentConfig as any;
      
      // Get AWS credentials with fallbacks
      const awsAccessKeyId = 
        deploymentConfig.config?.awsAccessKeyId || 
        deploymentConfig.awsAccessKeyId || 
        process.env.AWS_ACCESS_KEY_ID;
      
      const awsSecretAccessKey = 
        deploymentConfig.config?.awsSecretAccessKey || 
        deploymentConfig.awsSecretAccessKey || 
        process.env.AWS_SECRET_ACCESS_KEY;

      if (!awsAccessKeyId || !awsSecretAccessKey) {
        console.error('AWS credentials not found in config or environment');
        return res.status(500).json({ error: 'AWS credentials not configured' });
      }

      const instanceProvisioner = new InstanceProvisionerService(
        prisma,
        {
          region: deploymentConfig.config?.region || deploymentConfig.region || process.env.AWS_DEFAULT_REGION || 'us-east-1',
          imageId: 'ami-0889a44b331db0194',
          keyName: deploymentConfig.config?.keyName || deploymentConfig.keyName || '',
          securityGroupIds: deploymentConfig.config?.securityGroupIds || deploymentConfig.securityGroupIds || [],
          subnetId: deploymentConfig.config?.subnetId || deploymentConfig.subnetId || ''
        },
        awsAccessKeyId,
        awsSecretAccessKey
      );

      // Terminate the EC2 instance
      await instanceProvisioner.terminateInstance(autoDeployment.id);
    }

    // Delete the deployed app record
    await prisma.deployedApp.delete({
      where: { id }
    });

    res.json({ message: 'Deployment deleted successfully' });
  } catch (error) {
    console.error('Error deleting deployed app:', error);
    res.status(500).json({ error: 'Failed to delete deployment' });
  }
});

export default router; 