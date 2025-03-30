import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Trash2, ChevronDown } from 'lucide-react';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { PipelineSteps } from '@/components/pipelines/PipelineSteps';
import { BuildArtifacts } from '@/components/builds/BuildArtifacts';
import type { Build as ApiBuild } from '@/types/api';

interface StepResult {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  duration?: string;
  logs?: string[];
  error?: string;
  output?: string;
}

interface Build extends ApiBuild {
  stepResults?: StepResult[];
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

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

const PipelineHistory: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalBuilds, setTotalBuilds] = useState(0);
  const itemsPerPage = 10;
  const [expandedBuildId, setExpandedBuildId] = useState<string | null>(null);

  console.log('PipelineHistory rendering with state:', {
    id,
    loading,
    error,
    buildsCount: builds?.length ?? 0,
    currentPage,
    totalPages,
    totalBuilds
  });

  useEffect(() => {
    const fetchPipeline = async () => {
      try {
        const data = await api.getPipeline(id!);
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
      setLoading(true); // Set loading state to true before fetch

      try {
        const response = await api.listRuns(currentPage, itemsPerPage, id);
        setBuilds(response.data);
        
        // Handle total builds - use 0 for any non-numeric values
        let totalValue = 0;
        try {
          totalValue = Number(response.total);
          if (isNaN(totalValue)) totalValue = 0;
        } catch (e) {
          totalValue = 0;
        }
        setTotalBuilds(totalValue);
        
        // Calculate pages without direct arithmetic that triggers linter
        let calculatedPages = 1;
        if (totalValue > 0 && itemsPerPage > 0) {
          calculatedPages = Math.max(1, Math.ceil(totalValue / itemsPerPage));
        }
        
        setTotalPages(calculatedPages);
        setError(null);
      } catch (err) {
        console.error('Error fetching builds:', err);
        setError('Failed to load builds');
      } finally {
        setLoading(false); // IMPORTANT: Set loading to false regardless of success/failure
      }
    };

    fetchBuilds();
  }, [id, currentPage, itemsPerPage]);

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

  const handleDeleteBuild = async (buildId: string) => {
    try {
      await api.deleteBuild(buildId);
      setBuilds(builds.filter(build => build.id !== buildId));
      toast.success('Build deleted successfully');
    } catch (error) {
      console.error('Error deleting build:', error);
      toast.error('Failed to delete build');
    }
  };

  const toggleBuildExpanded = (buildId: string) => {
    setExpandedBuildId(prev => {
      if (prev === buildId) {
        return null;
      }
      return buildId;
    });
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
            Total Builds: {isNaN(totalBuilds) ? 0 : totalBuilds}
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
                    {build.commit && (
                      <span className="text-sm text-gray-500">
                        Commit: {build.commit.slice(0, 7)}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500">
                    Started: {new Date(build.startedAt || build.createdAt).toLocaleString()}
                    {build.completedAt && build.startedAt && (
                      <span className="ml-2">
                        Duration: {formatDuration(build.startedAt, build.completedAt)}
                      </span>
                    )}
                  </div>
                  {Object.keys(build.parameters || {}).length > 0 && (
                    <div className="text-sm text-gray-500 mt-2">
                      Parameters: {Object.entries(build.parameters || {}).map(([key, value]) => (
                        <span key={key} className="mr-2">
                          {key}={value}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggleBuildExpanded(build.id)}
                    className="text-gray-500 hover:text-gray-700"
                  >
                    <ChevronDown 
                      className={`w-5 h-5 transform transition-transform ${
                        expandedBuildId === build.id ? 'rotate-180' : ''
                      }`}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeleteBuild(build.id)}
                    className="text-gray-500 hover:text-red-600"
                  >
                    <Trash2 className="w-5 h-5" />
                  </Button>
                </div>
              </div>
              
              {expandedBuildId === build.id && (
                <div className="mt-4 space-y-4">
                  {build.stepResults && (
                    <PipelineSteps 
                      steps={build.stepResults.map(step => ({
                        name: step.name,
                        status: step.status,
                        duration: step.duration ? `${Math.floor(step.duration / 60)}m ${step.duration % 60}s` : undefined,
                        logs: step.output ? [step.output] : undefined,
                        error: step.error
                      }))} 
                      expanded={true}
                    />
                  )}
                  
                  <BuildArtifacts buildId={build.id} />
                </div>
              )}
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
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1 || loading}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-sm text-gray-500">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages || loading}
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