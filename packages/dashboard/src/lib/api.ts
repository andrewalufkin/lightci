import axios from 'axios';
import type { Pipeline, Build, BuildLog, Artifact, DeployedApp, PaginatedResponse } from '@/types/api';

const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

// Create a base axios instance with common configuration
const axiosInstance = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add request interceptor to include auth token
axiosInstance.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token && config.headers) {
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

// Add response interceptor to handle common errors
axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('auth_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// API Client methods
const api = {
  // Base axios instance
  client: axiosInstance,

  // Pipeline methods
  async listPipelines(page = 1, limit = 10): Promise<PaginatedResponse<Pipeline>> {
    const { data } = await axiosInstance.get<PaginatedResponse<Pipeline>>(`/pipelines?page=${page}&limit=${limit}`);
    return data;
  },

  async createPipeline(pipelineData: {
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
    const { data } = await axiosInstance.post<Pipeline>('/pipelines', pipelineData);
    return data;
  },

  async getPipeline(id: string): Promise<Pipeline & { latestBuilds: Build[] }> {
    const { data } = await axiosInstance.get<Pipeline & { latestBuilds: Build[] }>(`/pipelines/${id}`);
    return data;
  },

  async updatePipeline(id: string, pipelineData: Partial<Pipeline>): Promise<Pipeline> {
    const { data } = await axiosInstance.put<Pipeline>(`/pipelines/${id}`, pipelineData);
    return data;
  },

  async deletePipeline(id: string): Promise<void> {
    await axiosInstance.delete(`/pipelines/${id}`);
  },

  async triggerPipeline(id: string, data: {
    branch?: string;
    commit?: string;
  }): Promise<{ buildId: string; status: string; queuePosition: number }> {
    const { data: responseData } = await axiosInstance.post<{ buildId: string; status: string; queuePosition: number }>(`/pipelines/${id}/trigger`, data);
    return responseData;
  },

  // Build methods
  async listRuns(page = 1, limit = 10, pipelineId?: string): Promise<PaginatedResponse<Build>> {
    const url = pipelineId 
      ? `/pipeline-runs?page=${page}&limit=${limit}&pipelineId=${pipelineId}`
      : `/pipeline-runs?page=${page}&limit=${limit}`;
    const { data } = await axiosInstance.get<PaginatedResponse<Build>>(url);
    return {
      ...data,
      total: Number(data.total),
      page: Number(data.page),
      limit: Number(data.limit)
    };
  },

  async getRun(id: string): Promise<Build> {
    const { data } = await axiosInstance.get<Build>(`/pipeline-runs/${id}`);
    return data;
  },

  async getRunLogs(id: string): Promise<BuildLog[]> {
    const { data } = await axiosInstance.get<BuildLog[]>(`/pipeline-runs/${id}/logs`);
    return data;
  },

  async deleteBuild(buildId: string): Promise<void> {
    await axiosInstance.delete(`/pipeline-runs/${buildId}`);
  },

  // Artifact methods
  async downloadArtifact(id: string): Promise<Blob> {
    const { data } = await axiosInstance.get<Blob>(`/artifacts/${id}/download`, {
      responseType: 'blob'
    });
    return data;
  },

  async listBuildArtifacts(buildId: string): Promise<{ artifacts: Artifact[]; count: number; size: number; path: string }> {
    const { data } = await axiosInstance.get<{ artifacts: Artifact[]; count: number; size: number; path: string }>(`/pipeline-runs/${buildId}/artifacts`);
    return data;
  },

  // Project methods
  async createProject(projectData: {
    name: string;
    description?: string;
    visibility?: string;
    defaultBranch?: string;
    pipelineIds?: string[];
    settings?: Record<string, any>;
  }): Promise<any> {
    const { data } = await axiosInstance.post('/projects', projectData);
    return data;
  },

  async listProjects(): Promise<any[]> {
    const { data } = await axiosInstance.get<any[]>('/projects');
    return data;
  },

  async getProject(id: string): Promise<any> {
    const { data } = await axiosInstance.get<any>(`/projects/${id}`);
    return data;
  },

  async updateProject(id: string, projectData: {
    name?: string;
    description?: string;
    visibility?: string;
    defaultBranch?: string;
    pipelineIds?: string[];
    settings?: Record<string, any>;
  }): Promise<any> {
    const { data } = await axiosInstance.put(`/projects/${id}`, projectData);
    return data;
  },

  async deleteProject(id: string): Promise<void> {
    await axiosInstance.delete(`/projects/${id}`);
  },

  // Deployed apps methods
  async listDeployedApps(page = 1, limit = 10): Promise<PaginatedResponse<DeployedApp>> {
    const { data } = await axiosInstance.get<PaginatedResponse<DeployedApp>>(`/deployed-apps?page=${page}&limit=${limit}`);
    return data;
  },

  async deleteDeployedApp(id: string): Promise<void> {
    await axiosInstance.delete(`/deployed-apps/${id}`);
  },

  // Billing methods
  async getBillingUsage(): Promise<any> {
    const { data } = await axiosInstance.get('/user/billing/usage');
    return data;
  },

  async getStorageLimits(): Promise<any> {
    const { data } = await axiosInstance.get('/user/storage-limits');
    return data;
  },

  async listDomains(deployedAppId: string): Promise<DomainResponse> {
    const { data } = await axiosInstance.get<DomainResponse>(`/domains/app/${deployedAppId}`);
    return data;
  },

  async addDomain(domain: string, deployedAppId: string): Promise<Domain> {
    const { data } = await axiosInstance.post<Domain>('/domains', { domain, deployedAppId });
    return data;
  },

  async verifyDomain(id: string): Promise<VerifyDomainResponse> {
    const { data } = await axiosInstance.post<VerifyDomainResponse>(`/domains/${id}/verify`);
    return data;
  },

  async deleteDomain(id: string): Promise<DeleteDomainResponse> {
    const { data } = await axiosInstance.delete<DeleteDomainResponse>(`/domains/${id}`);
    return data;
  }
};

export { api };
export type { Pipeline, Build, BuildLog, Artifact, DeployedApp, PaginatedResponse };

// Domain interfaces
interface Domain {
  id: string;
  domain: string;
  verified: boolean;
  status: string;
  verifyToken: string;
  deployedAppId: string;
  createdAt: string;
  updatedAt: string;
}

interface DomainResponse {
  domains: Domain[];
}

interface VerifyDomainResponse {
  success: boolean;
  domain?: Domain;
  message?: string;
}

interface DeleteDomainResponse {
  success: boolean;
} 