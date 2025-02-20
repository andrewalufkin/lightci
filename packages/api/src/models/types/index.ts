export enum BuildStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed'
}

export enum TriggerType {
  Webhook = 'webhook',
  Manual = 'manual',
  Scheduled = 'scheduled'
}

export enum WebhookEvent {
  Push = 'push',
  PullRequest = 'pull_request'
}

export type PipelineStatus = BuildStatus;

export interface PaginationOptions {
  page: number;
  limit: number;
  filter?: string;
  sort?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
} 