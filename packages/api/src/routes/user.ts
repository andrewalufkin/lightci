import { Router } from 'express';
import type { Response } from 'express-serve-static-core';
import { userService } from '../services/user.service.js';
import { BillingService } from '../services/billing.service.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.middleware.js';
import { prisma } from '../lib/prisma.js';

// Define explicit types for Express Request and Response
interface ExpressRequest {
  user: {
    id: string;
    [key: string]: any;
  };
  [key: string]: any;
}

interface BillingUsage {
  currentMonth: {
    build_minutes: number;
    storage_gb: number;
  }
}

const router = Router();
const billingService = new BillingService();

// Define the tier type to ensure type safety
type AccountTier = 'free' | 'basic' | 'professional' | 'enterprise';

// Get user profile
router.get('/profile', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await userService.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Get user's billing usage
router.get('/billing/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const usage = await billingService.getUserBillingUsage(req.user.id);
    res.json(usage);
  } catch (error) {
    console.error('[UserRoutes] Error getting billing usage:', error);
    res.status(500).json({ error: 'Failed to get billing usage' });
  }
});

// Get user's storage limits
router.get('/storage-limits', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limits = await billingService.checkStorageLimit(req.user.id);
    res.json({
      currentUsageMB: limits.currentUsageMB,
      limitMB: limits.limitMB,
      remainingMB: limits.remainingMB,
      usagePercentage: (limits.currentUsageMB / limits.limitMB) * 100,
      tier: req.user.accountTier || 'free',
      tierName: (req.user.accountTier || 'free').charAt(0).toUpperCase() + (req.user.accountTier || 'free').slice(1)
    });
  } catch (error) {
    console.error('[UserRoutes] Error getting storage limits:', error);
    res.status(500).json({ error: 'Failed to get storage limits' });
  }
});

// Get user's artifact storage usage
router.get('/storage-usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const usage = await userService.calculateArtifactStorageUsage(req.user.id);
    res.json(usage);
  } catch (error) {
    console.error('Error fetching storage usage:', error);
    res.status(500).json({ error: 'Failed to get storage usage' });
  }
});

// Upgrade user's plan
router.post('/upgrade-plan', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { plan } = req.body;
    
    // Validate the plan
    const validPlans: AccountTier[] = ['free', 'basic', 'professional', 'enterprise'];
    if (!validPlans.includes(plan as AccountTier)) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    // Update user's plan in the database
    await prisma.user.update({
      where: { id: req.user.id },
      data: { accountTier: plan },
    });

    res.json({ message: 'Plan updated successfully' });
  } catch (error) {
    console.error('[UserRoutes] Error upgrading plan:', error);
    res.status(500).json({ error: 'Failed to upgrade plan' });
  }
});

export default router;