import { Router } from 'express';
import { userService } from '../services/user.service.js';
import { BillingService } from '../services/billing.service.js';
import { authenticate } from '../middleware/auth.middleware.js';

// Define explicit types for Express Request and Response
interface ExpressRequest {
  user: {
    id: string;
    [key: string]: any;
  };
  [key: string]: any;
}

interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(body: any): void;
  [key: string]: any;
}

const router = Router();
const billingService = new BillingService();

// Define the tier type to ensure type safety
type AccountTier = 'free' | 'basic' | 'professional' | 'enterprise';

// Get user profile
router.get('/profile', authenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    // Since authenticate middleware ensures req.user exists, we can safely use it
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

// Get user's storage limit information
router.get('/storage-limits', authenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const storageInfo = await billingService.checkStorageLimit(req.user.id);
    // Add tier information
    const user = await userService.findById(req.user.id);

    const tierNames: Record<AccountTier, string> = {
      'free': 'Free',
      'basic': 'Basic',
      'professional': 'Professional',
      'enterprise': 'Enterprise'
    };

    const accountTier = (user?.accountTier || 'free') as AccountTier;
    
    res.json({
      ...storageInfo,
      tier: accountTier,
      tierName: tierNames[accountTier],
      usagePercentage: (storageInfo.currentUsageMB / storageInfo.limitMB) * 100
    });
  } catch (error) {
    console.error('Error fetching storage limits:', error);
    res.status(500).json({ error: 'Failed to fetch storage limits' });
  }
});

// Get user's artifact storage usage
router.get('/storage-usage', authenticate, async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const usage = await userService.calculateArtifactStorageUsage(req.user.id);
    res.json(usage);
  } catch (error) {
    console.error('Error fetching storage usage:', error);
    res.status(500).json({ error: 'Failed to fetch storage usage' });
  }
});

export default router;