import axios from 'axios';

export interface Pipeline {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  steps: {
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    duration?: string;
    logs?: string[];
    error?: string;
  }[];
  artifactsEnabled: boolean;
  artifactPatterns: string[];
  artifactRetentionDays: number;
  artifactStorageType: string;
  artifactStorageConfig: Record<string, any>;
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
  stepResults?: {
    id: string;
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    command: string;
    output?: string;
    error?: string;
    duration?: number;
    startedAt?: string;
    completedAt?: string;
  }[];
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
  metadata?: Record<string, string>;
  createdAt: Date;
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
  private client: any;

  constructor() {
    const rawBaseURL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    
    // Create a URL object to properly parse the URL
    const url = new URL(rawBaseURL);
    
    // Remove trailing slashes from the pathname
    const cleanPath = url.pathname.replace(/\/+$/, '');
    
    // Check if the path ends with /api (not just contains it)
    if (!cleanPath.includes('/api')) {
      url.pathname = cleanPath + '/api';
    } else {
      url.pathname = cleanPath;
    }
    
    const finalBaseURL = url.toString().replace(/\/+$/, '');
    console.log('API Client initialized with baseURL:', finalBaseURL);
    
    this.client = axios.create({
      baseURL: finalBaseURL,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor to include auth token
    this.client.interceptors.request.use((config: any) => {
      const token = localStorage.getItem('auth_token');
      console.log('[Debug] Token from localStorage:', token ? 'Present' : 'Not found');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
        console.log('[Debug] Authorization header set:', config.headers.Authorization);
      } else {
        console.log('[Debug] No token found in localStorage');
        delete config.headers.Authorization; // Ensure no auth header is present if no token
      }
      console.log('[Debug] Making request to:', config.url, 'with headers:', JSON.stringify(config.headers, null, 2));
      return config;
    });

    // Add response interceptor for debugging
    this.client.interceptors.response.use(
      (response: any) => {
        console.log('Received response:', response.status, response.data);
        return response;
      },
      (error: any) => {
        console.error('API Error:', error.response?.status, error.response?.data);
        return Promise.reject(error);
      }
    );
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
    artifactsEnabled?: boolean;
    artifactPatterns?: string[];
    artifactRetentionDays?: number;
    artifactStorageType?: string;
    artifactStorageConfig?: Record<string, any>;
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
    artifactsEnabled?: boolean;
    artifactPatterns?: string[];
    artifactRetentionDays?: number;
    artifactStorageType?: string;
    artifactStorageConfig?: Record<string, any>;
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

  // Pipeline run endpoints
  async listRuns(page = 1, limit = 10, pipelineId?: string): Promise<PaginatedResponse<Build>> {
    const url = pipelineId 
      ? `/pipeline-runs?page=${page}&limit=${limit}&pipelineId=${pipelineId}`
      : `/pipeline-runs?page=${page}&limit=${limit}`;
    const response = await this.client.get(url);
    return response.data;
  }

  async getRun(id: string): Promise<Build> {
    const response = await this.client.get(`/pipeline-runs/${id}`);
    return response.data;
  }

  async getRunLogs(id: string): Promise<BuildLog[]> {
    const response = await this.client.get(`/pipeline-runs/${id}/logs`);
    return response.data;
  }

  async deleteBuild(buildId: string): Promise<void> {
    await this.client.delete(`/pipeline-runs/${buildId}`);
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

  // List artifacts for a build
  async listBuildArtifacts(buildId: string): Promise<Artifact[]> {
    const response = await this.client.get(`/runs/${buildId}/artifacts`);
    return response.data;
  }

  // Project endpoints
  async createProject(data: {
    name: string;
    description?: string;
    visibility?: string;
    defaultBranch?: string;
    pipelineIds?: string[];
    settings?: Record<string, any>;
  }): Promise<any> {
    const response = await this.client.post('/projects', data);
    return response.data;
  }

  async listProjects(): Promise<any[]> {
    const response = await this.client.get('/projects');
    return response.data;
  }

  async getProject(id: string): Promise<any> {
    const response = await this.client.get(`/projects/${id}`);
    return response.data;
  }

  async updateProject(id: string, data: {
    name?: string;
    description?: string;
    visibility?: string;
    defaultBranch?: string;
    pipelineIds?: string[];
    settings?: Record<string, any>;
  }): Promise<any> {
    const response = await this.client.put(`/projects/${id}`, data);
    return response.data;
  }

  async deleteProject(id: string): Promise<void> {
    await this.client.delete(`/projects/${id}`);
  }
}

export const api = new ApiClient(); 