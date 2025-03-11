import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Check } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from 'sonner';

interface PricingPlan {
  name: string;
  price: number;
  features: string[];
  resources: {
    storage: string;
    buildMinutes: string;
    artifactStorage: string;
    deploymentInstances: string;
  };
  overages: {
    storage: string;
    buildMinutes: string;
    artifactStorage: string;
    deploymentInstances: string;
  };
}

const plans: PricingPlan[] = [
  {
    name: 'Free',
    price: 0,
    features: [
      'Basic CI/CD pipeline',
      'Public repositories',
      'Community support',
    ],
    resources: {
      storage: '100MB',
      buildMinutes: '200/month',
      artifactStorage: '500MB',
      deploymentInstances: 'None',
    },
    overages: {
      storage: 'Not available',
      buildMinutes: 'Not available',
      artifactStorage: 'Not available',
      deploymentInstances: 'Not available',
    },
  },
  {
    name: 'Basic',
    price: 15,
    features: [
      'Everything in Free',
      'Private repositories',
      'Email support',
      'Custom deployment configurations',
    ],
    resources: {
      storage: '1GB',
      buildMinutes: '1,000/month',
      artifactStorage: '5GB',
      deploymentInstances: '1 small instance (20h/month)',
    },
    overages: {
      storage: '$0.05/GB/month',
      buildMinutes: '$0.01/minute',
      artifactStorage: '$0.03/GB/month',
      deploymentInstances: '$0.02/hour',
    },
  },
  {
    name: 'Professional',
    price: 40,
    features: [
      'Everything in Basic',
      'Priority support',
      'Advanced security features',
      'Team collaboration tools',
    ],
    resources: {
      storage: '5GB',
      buildMinutes: '5,000/month',
      artifactStorage: '25GB',
      deploymentInstances: '2 small or 1 medium instance (80h/month)',
    },
    overages: {
      storage: '$0.04/GB/month',
      buildMinutes: '$0.009/minute',
      artifactStorage: '$0.025/GB/month',
      deploymentInstances: '$0.018/hour',
    },
  },
  {
    name: 'Enterprise',
    price: 100,
    features: [
      'Everything in Professional',
      '24/7 dedicated support',
      'Custom integrations',
      'Advanced analytics',
      'SLA guarantees',
    ],
    resources: {
      storage: '20GB',
      buildMinutes: '15,000/month',
      artifactStorage: '100GB',
      deploymentInstances: 'Multiple instances (200h/month)',
    },
    overages: {
      storage: '$0.03/GB/month',
      buildMinutes: '$0.008/minute',
      artifactStorage: '$0.02/GB/month',
      deploymentInstances: '$0.015/hour',
    },
  },
];

interface PricingPlansProps {
  isOpen: boolean;
  onClose: () => void;
  currentPlan: string;
}

export const PricingPlans: React.FC<PricingPlansProps> = ({
  isOpen,
  onClose,
  currentPlan,
}) => {
  const handleUpgrade = async (planName: string) => {
    try {
      const normalizedPlanName = planName.toLowerCase();
      if (normalizedPlanName === currentPlan.toLowerCase()) {
        toast.info('You are already on this plan');
        return;
      }

      await api.post('/user/upgrade-plan', { plan: normalizedPlanName });
      toast.success(`Successfully upgraded to ${planName} plan`);
      onClose();
      // Reload the page to reflect changes
      window.location.reload();
    } catch (error) {
      console.error('Error upgrading plan:', error);
      toast.error('Failed to upgrade plan. Please try again later.');
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Choose Your Plan</DialogTitle>
          <DialogDescription>
            Select the plan that best fits your needs. All plans include automatic upgrades and 24/7 system monitoring.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mt-4">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className="border rounded-lg p-6 space-y-4 hover:border-blue-500 transition-colors"
            >
              <div className="space-y-2">
                <h3 className="text-xl font-bold">{plan.name}</h3>
                <p className="text-3xl font-bold">
                  ${plan.price}
                  <span className="text-base font-normal text-gray-600">/month</span>
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <h4 className="font-semibold mb-2">Resources</h4>
                  <ul className="space-y-2 text-sm">
                    <li>Storage: {plan.resources.storage}</li>
                    <li>Build Minutes: {plan.resources.buildMinutes}</li>
                    <li>Artifact Storage: {plan.resources.artifactStorage}</li>
                    <li>Deployment: {plan.resources.deploymentInstances}</li>
                  </ul>
                </div>

                <div>
                  <h4 className="font-semibold mb-2">Features</h4>
                  <ul className="space-y-2">
                    {plan.features.map((feature, index) => (
                      <li key={index} className="flex items-start space-x-2 text-sm">
                        <Check className="h-4 w-4 text-green-500 mt-0.5" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <h4 className="font-semibold mb-2">Overages</h4>
                  <ul className="space-y-2 text-sm">
                    <li>Storage: {plan.overages.storage}</li>
                    <li>Build Minutes: {plan.overages.buildMinutes}</li>
                    <li>Artifact Storage: {plan.overages.artifactStorage}</li>
                    <li>Deployment: {plan.overages.deploymentInstances}</li>
                  </ul>
                </div>
              </div>

              <Button
                className="w-full mt-4"
                variant={currentPlan.toLowerCase() === plan.name.toLowerCase() ? 'secondary' : 'default'}
                onClick={() => handleUpgrade(plan.name)}
                disabled={currentPlan.toLowerCase() === plan.name.toLowerCase()}
              >
                {currentPlan.toLowerCase() === plan.name.toLowerCase()
                  ? 'Current Plan'
                  : 'Upgrade'}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}; 