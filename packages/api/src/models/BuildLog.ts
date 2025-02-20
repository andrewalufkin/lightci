export interface BuildLog {
  stepId: string;
  content: string;
  timestamp: Date;
  level?: 'info' | 'warning' | 'error';
} 