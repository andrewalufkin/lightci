import axios, { AxiosInstance } from 'axios';

export interface Pipeline {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface Build {
  id: string;
  pipelineId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  branch: string;
  commit: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  logs?: BuildLog[];
  artifacts?: Artifact[];
}

export interface BuildLog {
  id: string;
  buildId: string;
  stepId: string;
  content: string;
  level?: string;
  timestamp: string;
}

export interface Artifact {
  id: string;
  buildId: string;
  name: string;
  path: string;
  size: number;
  contentType?: string;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
  };
}

class ApiClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3000/api',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': import.meta.env.VITE_API_KEY || 'dev-api-key'
      }
    });
  }

  // Pipeline endpoints
  async listPipelines(page = 1, limit = 10): Promise<PaginatedResponse<Pipeline>> {
    const response = await this.client.get(`/pipelines?page=${page}&limit=${limit}`);
    return response.data;
  }

  async createPipeline(data: {
    name: string;
    repository: string;
    defaultBranch?: string;
    steps: { name: string; command: string }[];
  }): Promise<Pipeline> {
    const response = await this.client.post('/pipelines', data);
    return response.data;
  }

  async getPipeline(id: string): Promise<Pipeline & { latestBuilds: Build[] }> {
    const response = await this.client.get(`/pipelines/${id}`);
    return response.data;
  }

  async updatePipeline(id: string, data: {
    name: string;
    repository: string;
    defaultBranch?: string;
    steps: { name: string; command: string }[];
  }): Promise<Pipeline> {
    const response = await this.client.put(`/pipelines/${id}`, data);
    return response.data;
  }

  async deletePipeline(id: string): Promise<void> {
    await this.client.delete(`/pipelines/${id}`);
  }

  async triggerPipeline(id: string, data: {
    branch?: string;
    commit?: string;
  }): Promise<{ buildId: string; status: string; queuePosition: number }> {
    const response = await this.client.post(`/pipelines/${id}/trigger`, data);
    return response.data;
  }

  // Build endpoints
  async listBuilds(page = 1, limit = 10, pipelineId?: string): Promise<PaginatedResponse<Build>> {
    const url = pipelineId 
      ? `/builds?page=${page}&limit=${limit}&pipelineId=${pipelineId}`
      : `/builds?page=${page}&limit=${limit}`;
    const response = await this.client.get(url);
    return response.data;
  }

  async getBuild(id: string): Promise<Build> {
    const response = await this.client.get(`/builds/${id}`);
    return response.data;
  }

  async cancelBuild(id: string): Promise<void> {
    await this.client.post(`/builds/${id}/cancel`);
  }

  async getBuildLogs(id: string): Promise<BuildLog[]> {
    const response = await this.client.get(`/builds/${id}/logs`);
    return response.data;
  }

  async getBuildArtifacts(id: string): Promise<Artifact[]> {
    const response = await this.client.get(`/builds/${id}/artifacts`);
    return response.data;
  }

  // Artifact endpoints
  async downloadArtifact(id: string): Promise<Blob> {
    const response = await this.client.get(`/artifacts/${id}`, {
      responseType: 'blob'
    });
    return response.data;
  }

  async uploadArtifact(data: {
    buildId: string;
    name: string;
    contentType?: string;
    size: number;
    metadata?: Record<string, string>;
  }): Promise<Artifact> {
    const response = await this.client.post('/artifacts', data);
    return response.data;
  }

  async deleteArtifact(id: string): Promise<void> {
    await this.client.delete(`/artifacts/${id}`);
  }
}

export const api = new ApiClient(); 