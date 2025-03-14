import { Router } from 'express';
import type { Request, Response } from 'express-serve-static-core';
import Stripe from 'stripe';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY must be defined');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-02-24.acacia'
});

const router = Router();

const createPaymentSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().default('usd'),
  description: z.string().optional(),
  userId: z.string(),
  plan: z.string()
});

router.post('/create-payment-intent', async (req: Request, res: Response) => {
  try {
    const { amount, currency, description, userId, plan } = createPaymentSchema.parse(req.body);
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      description,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        userId,
        plan
      }
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.errors });
      return;
    }
    console.error('Stripe payment intent error:', error);
    res.status(500).json({ error: 'Failed to create payment intent' });
  }
});

// Webhook signing secret for verification
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  throw new Error('STRIPE_WEBHOOK_SECRET must be defined');
}

// Webhook handler
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string | undefined;

  if (!sig) {
    res.status(400).json({ error: 'No signature header' });
    return;
  }

  try {
    const event = stripe.webhooks.constructEvent(
      req.body as any,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET ?? ''
    );

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await handleSuccessfulPayment(paymentIntent);
        break;
      }
      
      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await handleFailedPayment(paymentIntent);
        break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(400).json({ error: 'Webhook error' });
  }
});

async function handleSuccessfulPayment(paymentIntent: Stripe.PaymentIntent) {
  const { metadata } = paymentIntent;
  if (!metadata?.userId || !metadata?.plan) {
    console.error('Missing metadata in payment intent');
    return;
  }

  try {
    await prisma.user.update({
      where: { id: metadata.userId },
      data: {
        accountTier: metadata.plan,
        payment_history: {
          push: {
            amount: paymentIntent.amount,
            status: 'succeeded',
            date: new Date(),
            paymentIntentId: paymentIntent.id
          }
        }
      }
    });
  } catch (error) {
    console.error('Error updating user subscription:', error);
  }
}

async function handleFailedPayment(paymentIntent: Stripe.PaymentIntent) {
  const { metadata } = paymentIntent;
  if (!metadata?.userId) {
    console.error('Missing userId in payment intent metadata');
    return;
  }

  try {
    await prisma.user.update({
      where: { id: metadata.userId },
      data: {
        payment_history: {
          push: {
            amount: paymentIntent.amount,
            status: 'failed',
            date: new Date(),
            paymentIntentId: paymentIntent.id,
            error: paymentIntent.last_payment_error?.message
          }
        }
      }
    });
  } catch (error) {
    console.error('Error recording failed payment:', error);
  }
}

export default router; 