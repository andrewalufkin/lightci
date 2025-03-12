import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { PaymentForm } from '../PaymentForm';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth.context';

interface UpgradeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  planName: string;
  planPrice: number;
}

export const UpgradeDialog: React.FC<UpgradeDialogProps> = ({
  isOpen,
  onClose,
  planName,
  planPrice,
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const { user } = useAuth();

  const handleSuccess = async () => {
    try {
      setIsProcessing(true);
      const normalizedPlanName = planName.toLowerCase();
      await api.post('/user/upgrade-plan', { plan: normalizedPlanName });
      toast.success(`Successfully upgraded to ${planName} plan`);
      onClose();
      // Reload the page to reflect changes
      window.location.reload();
    } catch (error) {
      console.error('Error upgrading plan:', error);
      toast.error('Failed to upgrade plan. Please try again later.');
    } finally {
      setIsProcessing(false);
    }
  };

  if (!user) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upgrade to {planName}</DialogTitle>
          <DialogDescription>
            Complete your payment to upgrade to the {planName} plan.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-4">
          <PaymentForm 
            amount={planPrice * 100} // Convert to cents
            onSuccess={handleSuccess}
            disabled={isProcessing}
            userId={user.id}
            plan={planName.toLowerCase()}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}; 