import React, { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Link, useNavigate } from 'react-router-dom';
import { Play, Settings, GitBranch, History, ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { PipelineSteps } from '@/components/pipelines/PipelineSteps';

interface Pipeline {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
  description?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 
          'PIPELINE_STATUS_PENDING' | 'PIPELINE_STATUS_RUNNING' | 'PIPELINE_STATUS_COMPLETED' | 'PIPELINE_STATUS_FAILED';
  createdAt: string;
  updatedAt: string;
  steps: {
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    duration?: string;
    logs?: string[];
  }[];
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_KEY = import.meta.env.VITE_API_KEY;

const StatusBadge: React.FC<{ status: Pipeline['status'] }> = ({ status }) => {
  const getStatusColor = (status: Pipeline['status']) => {
    // Convert status to lowercase for case-insensitive comparison
    const normalizedStatus = status.toLowerCase();
    
    if (normalizedStatus.includes('running')) {
      return 'bg-blue-500 hover:bg-blue-600';
    }
    if (normalizedStatus.includes('completed')) {
      return 'bg-green-500 hover:bg-green-600';
    }
    if (normalizedStatus.includes('failed')) {
      return 'bg-red-500 hover:bg-red-600';
    }
    if (normalizedStatus.includes('pending')) {
      return 'bg-yellow-500 hover:bg-yellow-600';
    }
    return 'bg-yellow-500 hover:bg-yellow-600'; // Default case
  };

  const formatStatus = (status: Pipeline['status']) => {
    // First convert to lowercase
    const lowercaseStatus = status.toLowerCase();
    // Remove any pipeline_status_ prefix
    const cleanStatus = lowercaseStatus.replace('pipeline_status_', '');
    // Capitalize first letter
    return cleanStatus.charAt(0).toUpperCase() + cleanStatus.slice(1);
  };

  return (
    <Badge className={`${getStatusColor(status)} text-white capitalize`}>
      {formatStatus(status)}
    </Badge>
  );
};

const PipelinesPage: React.FC = () => {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningPipelines, setRunningPipelines] = useState<Set<string>>(new Set());
  const [expandedPipelines, setExpandedPipelines] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  useEffect(() => {
    const fetchPipelines = async () => {
      try {
        const response = await fetch(`${API_URL}/api/pipelines`, {
          headers: {
            'Accept': 'application/json',
            'x-api-key': API_KEY,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to fetch pipelines');
        }

        const data = await response.json();
        setPipelines(data.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        console.error('Error fetching pipelines:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchPipelines();

    // Set up polling for running pipelines
    const pollInterval = setInterval(async () => {
      const runningPipelineIds = Array.from(runningPipelines);
      if (runningPipelineIds.length === 0) return;

      try {
        const updatedPipelines = await Promise.all(
          runningPipelineIds.map(async (id) => {
            const response = await fetch(`${API_URL}/api/pipelines/${id}`, {
              headers: {
                'Accept': 'application/json',
                'x-api-key': API_KEY,
              },
            });
            if (!response.ok) throw new Error(`Failed to fetch pipeline ${id}`);
            return response.json();
          })
        );

        setPipelines(prev => 
          prev.map(pipeline => {
            const updated = updatedPipelines.find(p => p.id === pipeline.id);
            return updated ? { ...pipeline, ...updated } : pipeline;
          })
        );

        // Remove completed pipelines from running set
        setRunningPipelines(prev => {
          const next = new Set(prev);
          updatedPipelines.forEach(pipeline => {
            if (pipeline.status !== 'running' && pipeline.status !== 'PIPELINE_STATUS_RUNNING') {
              next.delete(pipeline.id);
            }
          });
          return next;
        });
      } catch (err) {
        console.error('Error polling pipelines:', err);
      }
    }, 5000); // Poll every 5 seconds

    return () => clearInterval(pollInterval);
  }, [runningPipelines]);

  const toggleExpanded = (pipelineId: string) => {
    setExpandedPipelines(prev => {
      const next = new Set(prev);
      if (next.has(pipelineId)) {
        next.delete(pipelineId);
      } else {
        next.add(pipelineId);
      }
      return next;
    });
  };

  const runPipeline = async (pipelineId: string) => {
    if (runningPipelines.has(pipelineId)) return;

    try {
      setRunningPipelines(prev => new Set(prev).add(pipelineId));
      
      const response = await fetch(`${API_URL}/api/pipelines/${pipelineId}/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
        },
        body: JSON.stringify({
          branch: pipelines.find(p => p.id === pipelineId)?.defaultBranch,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to trigger pipeline');
      }

      const data = await response.json();
      toast.success('Pipeline triggered successfully');
      
      // Update the pipeline status in the list
      setPipelines(prev => 
        prev.map(pipeline => 
          pipeline.id === pipelineId 
            ? { ...pipeline, status: 'running' }
            : pipeline
        )
      );

    } catch (err) {
      console.error('Error triggering pipeline:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to trigger pipeline');
    } finally {
      setRunningPipelines(prev => {
        const next = new Set(prev);
        next.delete(pipelineId);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="container py-8">
        <div className="text-center">Loading pipelines...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container py-8">
        <div className="text-center text-red-500">
          Error: {error}
          <Button
            variant="outline"
            className="ml-4"
            onClick={() => window.location.reload()}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (pipelines.length === 0) {
    return (
      <div className="container py-8">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-4">No pipelines found</h2>
          <p className="text-muted-foreground mb-4">
            Get started by creating your first pipeline
          </p>
          <Link
            to="/pipelines/new"
            className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
          >
            Create Pipeline
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8">
      <div className="space-y-4">
        {pipelines.map((pipeline) => {
          const isExpanded = expandedPipelines.has(pipeline.id);
          const isRunning = runningPipelines.has(pipeline.id) || 
                           pipeline.status === 'running' || 
                           pipeline.status === 'PIPELINE_STATUS_RUNNING';

          return (
            <Card key={pipeline.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-4">
                    <h3 className="text-lg font-medium text-gray-900">{pipeline.name}</h3>
                    <StatusBadge status={pipeline.status} />
                    <span className="text-sm text-gray-500">
                      <GitBranch className="w-4 h-4 inline mr-1" />
                      {pipeline.defaultBranch}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Button 
                      variant="ghost" 
                      size="icon"
                      onClick={() => toggleExpanded(pipeline.id)}
                    >
                      {isExpanded ? (
                        <ChevronUp className="w-5 h-5" />
                      ) : (
                        <ChevronDown className="w-5 h-5" />
                      )}
                    </Button>
                    <Button variant="ghost" size="icon" asChild>
                      <Link to={`/pipelines/${pipeline.id}/settings`}>
                        <Settings className="w-5 h-5" />
                      </Link>
                    </Button>
                    <Button variant="ghost" size="icon" asChild>
                      <Link to={`/pipelines/${pipeline.id}/history`}>
                        <History className="w-5 h-5" />
                      </Link>
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon"
                      disabled={isRunning}
                      onClick={() => runPipeline(pipeline.id)}
                    >
                      <Play className={`w-5 h-5 ${isRunning ? 'animate-pulse' : ''}`} />
                    </Button>
                  </div>
                </div>
                {pipeline.description && (
                  <p className="text-gray-600 text-sm mb-4">{pipeline.description}</p>
                )}
                {isExpanded && pipeline.steps && (
                  <div className="mt-4">
                    <PipelineSteps 
                      steps={pipeline.steps} 
                      expanded={isRunning}
                    />
                  </div>
                )}
                <div className="text-sm text-gray-500 mt-4">
                  Created {new Date(pipeline.createdAt).toLocaleDateString()}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

export default PipelinesPage; 