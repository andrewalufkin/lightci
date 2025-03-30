import { useMemo } from 'react';
import { api } from '@/lib/api';

export function useApi() {
  return useMemo(() => api, []);
} 