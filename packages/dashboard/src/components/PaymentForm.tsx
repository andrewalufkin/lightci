import { useState, useEffect } from 'react';
import {
  PaymentElement,
  Elements,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { stripePromise, createPaymentIntent } from '../services/payment';

const CheckoutForm = ({ onSuccess, disabled }: { onSuccess?: () => void, disabled?: boolean }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string>();
  const [processing, setProcessing] = useState(false);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (stripe && elements) {
      setIsReady(true);
    }
  }, [stripe, elements]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements || disabled) return;

    setProcessing(true);
    setError(undefined);

    const { error: submitError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/payment-complete`,
      },
      redirect: 'if_required',
    });

    if (submitError) {
      setError(submitError.message);
      setProcessing(false);
    } else {
      onSuccess?.();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="max-w-md mx-auto p-4">
      <PaymentElement onReady={() => setIsReady(true)} />
      {error && (
        <div className="text-red-500 mt-2 text-sm">{error}</div>
      )}
      <button
        type="submit"
        disabled={!isReady || processing || disabled}
        className="mt-4 w-full bg-blue-500 text-white py-2 px-4 rounded hover:bg-blue-600 disabled:opacity-50"
      >
        {!isReady ? 'Loading...' : processing ? 'Processing...' : 'Pay Now'}
      </button>
    </form>
  );
};

interface PaymentFormProps {
  amount: number;
  onSuccess?: () => void;
  disabled?: boolean;
  userId: string;
  plan: string;
}

export const PaymentForm = ({ amount, onSuccess, disabled, userId, plan }: PaymentFormProps) => {
  const [clientSecret, setClientSecret] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    createPaymentIntent(amount, userId, plan)
      .then(({ clientSecret }) => setClientSecret(clientSecret))
      .catch((err) => {
        console.error('Failed to create payment intent:', err);
        setError('Failed to initialize payment. Please try again.');
      });
  }, [amount, userId, plan]);

  if (error) {
    return <div className="text-red-500 text-sm">{error}</div>;
  }

  if (!clientSecret) {
    return (
      <div className="flex items-center justify-center py-4">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <Elements stripe={stripePromise} options={{ 
      clientSecret,
      appearance: {
        theme: 'stripe',
        variables: {
          colorPrimary: '#3b82f6',
        },
      },
    }}>
      <CheckoutForm onSuccess={onSuccess} disabled={disabled} />
    </Elements>
  );
}; 