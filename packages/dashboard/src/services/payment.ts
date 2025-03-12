import { loadStripe } from '@stripe/stripe-js';

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY);

export const createPaymentIntent = async (amount: number, userId: string, plan: string) => {
  const response = await fetch('/api/stripe/create-payment-intent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount, userId, plan }),
  });

  if (!response.ok) {
    throw new Error('Payment failed');
  }

  return response.json();
};

export { stripePromise }; 