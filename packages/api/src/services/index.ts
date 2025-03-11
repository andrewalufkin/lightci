import { BillingService } from './billing.service.js';
import { prisma } from '../lib/prisma.js';

export const billingService = new BillingService(prisma); 