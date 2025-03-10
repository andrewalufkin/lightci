import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Progress } from '../ui/progress';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { InfoCircledIcon, ExclamationTriangleIcon } from '@radix-ui/react-icons';
import { api } from '../../lib/api';

interface StorageInfo {
  hasEnoughStorage: boolean;
  currentUsageMB: number;
  limitMB: number;
  remainingMB: number;
  tier: string;
  tierName: string;
  usagePercentage: number;
}

const StorageUsage: React.FC = () => {
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStorageInfo = async () => {
      try {
        setLoading(true);
        const response = await api.get('/api/user/storage-limits');
        setStorageInfo(response.data);
        setError(null);
      } catch (err) {
        console.error('Error fetching storage info:', err);
        setError('Failed to load storage information');
      } finally {
        setLoading(false);
      }
    };

    fetchStorageInfo();
  }, []);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Storage Usage</CardTitle>
          <CardDescription>Loading storage information...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error || !storageInfo) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Storage Usage</CardTitle>
          <CardDescription>Could not load storage information</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <ExclamationTriangleIcon className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error || 'Unknown error occurred'}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const { currentUsageMB, limitMB, usagePercentage, tierName, remainingMB } = storageInfo;
  const isLowStorage = remainingMB < 100; // Less than 100MB remaining
  const isNearLimit = usagePercentage > 80; // Over 80% used

  // Format numbers for display
  const formatStorage = (mb: number) => {
    if (mb >= 1024) {
      return `${(mb / 1024).toFixed(2)} GB`;
    }
    return `${Math.round(mb)} MB`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage Usage</CardTitle>
        <CardDescription>
          {tierName} tier - {formatStorage(limitMB)} total storage
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex justify-between mb-2">
            <span className="text-sm font-medium">
              {formatStorage(currentUsageMB)} used of {formatStorage(limitMB)}
            </span>
            <span className="text-sm font-medium">
              {usagePercentage.toFixed(1)}%
            </span>
          </div>
          <Progress value={usagePercentage} className="h-2" />
          <div className="mt-1 text-xs text-muted-foreground">
            {formatStorage(remainingMB)} remaining
          </div>
        </div>

        {(isLowStorage || isNearLimit) && (
          <Alert variant={isLowStorage ? "destructive" : "warning"}>
            <InfoCircledIcon className="h-4 w-4" />
            <AlertTitle>Storage {isLowStorage ? 'Critical' : 'Warning'}</AlertTitle>
            <AlertDescription>
              {isLowStorage
                ? `You're running very low on storage. Please upgrade your plan or remove unused artifacts to avoid pipeline failures.`
                : `You're approaching your storage limit. Consider upgrading your plan or removing unused artifacts.`}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
};

export default StorageUsage; 