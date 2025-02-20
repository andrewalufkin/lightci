export interface Artifact {
  id: string;
  buildId: string;
  name: string;
  path: string;
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
  createdAt: Date;
} 