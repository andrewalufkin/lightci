import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Build {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' |
          'PIPELINE_STATUS_PENDING' | 'PIPELINE_STATUS_RUNNING' | 'PIPELINE_STATUS_COMPLETED' | 'PIPELINE_STATUS_FAILED';
  branch: string;
  commit: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  parameters: Record<string, string>;
}

interface Pipeline {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
}

interface PaginatedResponse {
  data: Build[];
  pagination: {
    total: number;
    page: number;
    limit: number;
  };
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_KEY = import.meta.env.VITE_API_KEY;

const PipelineHistory: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalBuilds, setTotalBuilds] = useState(0);
  const limit = 10;

  console.log('PipelineHistory rendering with state:', {
    id,
    loading,
    error,
    buildsCount: builds?.length ?? 0,
    page,
    totalPages,
    totalBuilds
  });

  useEffect(() => {
    const fetchPipeline = async () => {
      try {
        const response = await fetch(
          `${API_URL}/api/pipelines/${id}`,
          {
            headers: {
              'Accept': 'application/json',
              'x-api-key': API_KEY,
            },
          }
        );

        if (!response.ok) {
          throw new Error('Failed to fetch pipeline details');
        }

        const data = await response.json();
        setPipeline(data);
      } catch (err) {
        console.error('Error fetching pipeline:', err);
        // Don't set error state here as we still want to show builds
      }
    };

    fetchPipeline();
  }, [id]);

  useEffect(() => {
    const fetchBuilds = async () => {
      try {
        setLoading(true);
        console.log('Fetching builds for pipeline:', id);
        const response = await fetch(
          `${API_URL}/api/builds?pipelineId=${id}&page=${page}&limit=${limit}`,
          {
            headers: {
              'Accept': 'application/json',
              'x-api-key': API_KEY,
            },
          }
        );

        if (!response.ok) {
          const errorData = await response.json();
          console.error('Error response:', errorData);
          throw new Error(errorData.error || 'Failed to fetch builds');
        }

        const responseText = await response.text();
        console.log('Raw response:', responseText);
        
        const data: PaginatedResponse = JSON.parse(responseText);
        console.log('Parsed data:', data);
        
        setBuilds(data.data);
        setTotalBuilds(data.pagination.total);
        setTotalPages(Math.ceil(data.pagination.total / limit));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        console.error('Error fetching builds:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchBuilds();
  }, [id, page]);

  const formatDuration = (start: string, end: string) => {
    const duration = new Date(end).getTime() - new Date(start).getTime();
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  };

  const getStatusColor = (status: Build['status']) => {
    // Convert status to lowercase for case-insensitive comparison
    const normalizedStatus = status.toLowerCase();
    
    if (normalizedStatus.includes('running')) {
      return 'bg-blue-100 text-blue-800';
    }
    if (normalizedStatus.includes('completed')) {
      return 'bg-green-100 text-green-800';
    }
    if (normalizedStatus.includes('failed')) {
      return 'bg-red-100 text-red-800';
    }
    if (normalizedStatus.includes('cancelled')) {
      return 'bg-gray-100 text-gray-800';
    }
    return 'bg-yellow-100 text-yellow-800';
  };

  if (loading && builds.length === 0) {
    return (
      <div className="container py-8">
        <div className="text-center">Loading builds...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container py-8">
        <div className="text-red-500">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="container py-8">
      <div className="flex justify-between items-center mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold">Build History</h1>
            {pipeline && (
              <span className="text-2xl text-gray-500">
                - {pipeline.name}
              </span>
            )}
          </div>
          <div className="text-sm text-gray-500">
            Total Builds: {totalBuilds}
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() => navigate('/')}
          className="flex items-center gap-2"
        >
          <ChevronLeft className="h-4 w-4" /> Back to Pipelines
        </Button>
      </div>
      
      <div className="space-y-4">
        {builds.map((build) => (
          <Card key={build.id}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <div className="flex items-center space-x-2">
                    <Badge className={getStatusColor(build.status)}>
                      {build.status.toLowerCase().replace('pipeline_status_', '').charAt(0).toUpperCase() + 
                       build.status.toLowerCase().replace('pipeline_status_', '').slice(1)}
                    </Badge>
                    <span className="text-sm text-gray-500">
                      Branch: {build.branch}
                    </span>
                    <span className="text-sm text-gray-500">
                      Commit: {build.commit.slice(0, 7)}
                    </span>
                  </div>
                  <div className="text-sm text-gray-500">
                    Started: {new Date(build.startedAt || build.createdAt).toLocaleString()}
                    {build.completedAt && build.startedAt && (
                      <span className="ml-2">
                        Duration: {formatDuration(build.startedAt, build.completedAt)}
                      </span>
                    )}
                  </div>
                  {Object.keys(build.parameters).length > 0 && (
                    <div className="text-sm text-gray-500 mt-2">
                      Parameters: {Object.entries(build.parameters).map(([key, value]) => (
                        <span key={key} className="mr-2">
                          {key}={value}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        
        {builds.length === 0 && (
          <div className="text-center text-gray-500">
            No builds found for this pipeline.
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex justify-center items-center space-x-2 mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-sm text-gray-500">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages || loading}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default PipelineHistory; 