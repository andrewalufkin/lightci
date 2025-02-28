export interface Step {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  command: string;
  output?: string;
  startedAt?: Date;
  completedAt?: Date;
  duration?: number;
  exitCode?: number;
  environment?: Record<string, string>;
  error?: string;
  runOnDeployedInstance?: boolean;
  runLocation?: 'local' | 'deployed';
}
