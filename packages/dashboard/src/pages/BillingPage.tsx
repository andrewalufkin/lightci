import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/lib/auth.context';
import { api } from '@/lib/api';
import { PricingPlans } from '@/components/billing/PricingPlans';

interface BillingUsage {
  currentMonth: {
    build_minutes: number;
    storage_gb: number;
  }
}

interface StorageLimits {
  currentUsageMB: number;
  limitMB: number;
  remainingMB: number;
  tier: string;
  tierName: string;
  usagePercentage: number;
}

interface User {
  credit_balance: number;
  // Add other user properties as needed
}

export default function BillingPage() {
  const { user } = useAuth() as { user: User | null };
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [storageLimits, setStorageLimits] = useState<StorageLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPricingPlans, setShowPricingPlans] = useState(false);

  useEffect(() => {
    const fetchBillingData = async () => {
      try {
        const [usageResponse, storageResponse] = await Promise.all([
          api.get('/user/billing/usage'),
          api.get('/user/storage-limits')
        ]);
        
        setUsage(usageResponse.data as BillingUsage);
        setStorageLimits(storageResponse.data as StorageLimits);
      } catch (err) {
        setError('Failed to load billing information');
        console.error('Error fetching billing data:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchBillingData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <h1 className="text-2xl font-semibold mb-4 text-red-600">Error</h1>
        <p className="text-gray-600">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Billing & Usage</h1>
        <button 
          onClick={() => setShowPricingPlans(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
        >
          Upgrade Plan
        </button>
      </div>

      {/* Current Plan */}
      <Card>
        <CardHeader>
          <CardTitle>Current Plan</CardTitle>
          <CardDescription>Your current subscription and credit balance</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="text-lg font-semibold">{storageLimits?.tierName || 'Free'} Plan</h3>
                <p className="text-sm text-gray-500">Monthly billing</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold">${(user?.credit_balance ?? 0).toFixed(2)}</p>
                <p className="text-sm text-gray-500">Credit Balance</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Usage Overview */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Build Minutes */}
        <Card>
          <CardHeader>
            <CardTitle>Build Minutes</CardTitle>
            <CardDescription>Current month's usage</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Used</span>
                <span className="font-semibold">{usage?.currentMonth.build_minutes || 0} minutes</span>
              </div>
              <Progress 
                value={Math.min((usage?.currentMonth.build_minutes || 0) / 5000 * 100, 100)} 
                className="h-2"
              />
              <p className="text-sm text-gray-500">
                {5000 - (usage?.currentMonth.build_minutes || 0)} minutes remaining this month
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Storage Usage */}
        <Card>
          <CardHeader>
            <CardTitle>Storage Usage</CardTitle>
            <CardDescription>Artifact and deployment storage</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Used</span>
                <span className="font-semibold">
                  {((storageLimits?.currentUsageMB ?? 0) / 1024).toFixed(2)} GB of {((storageLimits?.limitMB ?? 0) / 1024).toFixed(2)} GB
                </span>
              </div>
              <Progress 
                value={storageLimits?.usagePercentage ?? 0} 
                className="h-2"
              />
              <p className="text-sm text-gray-500">
                {((storageLimits?.remainingMB ?? 0) / 1024).toFixed(2)} GB remaining
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <PricingPlans 
        isOpen={showPricingPlans} 
        onClose={() => setShowPricingPlans(false)}
        currentPlan={storageLimits?.tier || 'free'}
      />
    </div>
  );
} 