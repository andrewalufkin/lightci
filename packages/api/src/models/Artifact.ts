export interface Artifact {
  id: string;
  buildId: string;
  name: string;
  path: string;
  size: number;
  contentType: string | null;
  metadata?: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
} 