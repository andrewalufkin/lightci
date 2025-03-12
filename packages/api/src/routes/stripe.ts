import { Router } from 'express';
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

router.post('/create-payment-intent', async (req, res) => {
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
      return res.status(400).json({ error: error.errors });
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
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    return res.status(400).json({ error: 'No signature header' });
  }

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        // Update user's subscription status
        await handleSuccessfulPayment(paymentIntent);
        break;
      
      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        // Handle failed payment
        await handleFailedPayment(failedPayment);
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(400).json({ error: 'Webhook error' });
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