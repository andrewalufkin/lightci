import { Router } from 'express';
import type { Request, Response } from 'express-serve-static-core';
import { authenticate } from '../middleware/auth.middleware.js';
import { billingService } from '../services/index.js';
import type { AuthenticatedRequest } from '../middleware/auth.middleware.js';

const router = Router();

// Get user's billing usage information
router.get('/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const usage = await billingService.getUserBillingUsage(req.user.id);
    res.json(usage);
  } catch (error) {
    console.error('Error fetching billing usage:', error);
    res.status(500).json({ error: 'Failed to fetch billing usage' });
  }
});

export default router; 