import React, { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Link, useNavigate } from 'react-router-dom';
import { Play, Settings, GitBranch, History, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { PipelineSteps } from '@/components/pipelines/PipelineSteps';
import { api, Pipeline } from '@/services/api';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const RunningTimer: React.FC<{ startTime: number }> = ({ startTime }) => {
  const [elapsedTime, setElapsedTime] = useState('0:00');

  useEffect(() => {
    const updateTimer = () => {
      const now = Date.now();
      const elapsed = Math.floor((now - startTime) / 1000); // Convert to seconds
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      setElapsedTime(`${minutes}:${seconds.toString().padStart(2, '0')}`);
    };

    updateTimer(); // Initial update
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <div className="flex items-center text-sm text-blue-700 ml-2">
      <Clock className="w-4 h-4 mr-1" />
      {elapsedTime}
    </div>
  );
};

const StatusBadge: React.FC<{ status: Pipeline['status']; startTime?: number }> = ({ status, startTime }) => {
  const getStatusColor = (status: Pipeline['status']) => {
    switch (status) {
      case 'running':
        return 'bg-blue-500 hover:bg-blue-600';
      case 'completed':
        return 'bg-green-500 hover:bg-green-600';
      case 'failed':
        return 'bg-red-500 hover:bg-red-600';
      case 'pending':
        return 'bg-yellow-500 hover:bg-yellow-600';
      default:
        return 'bg-yellow-500 hover:bg-yellow-600';
    }
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
    <div className="flex items-center">
      <Badge className={`${getStatusColor(status)} text-white capitalize`}>
        {formatStatus(status)}
      </Badge>
      {status === 'running' && startTime && <RunningTimer startTime={startTime} />}
    </div>
  );
};

const ProjectsList: React.FC = () => {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const data = await api.listProjects();
        setProjects(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        console.error('Error fetching projects:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchProjects();
  }, []);

  if (loading) {
    return <div className="text-center">Loading projects...</div>;
  }

  if (error) {
    return (
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
    );
  }

  if (projects.length === 0) {
    return (
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-4">No projects found</h2>
        <p className="text-muted-foreground mb-4">
          Get started by creating your first project
        </p>
        <Link
          to="/projects/new"
          className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 py-2"
        >
          Create Project
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {projects.map((project) => (
        <Card key={project.id}>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-medium">{project.name}</h3>
                {project.description && (
                  <p className="text-sm text-gray-500 mt-1">{project.description}</p>
                )}
              </div>
              <div className="space-x-2">
                <Link
                  to={`/projects/${project.id}/settings`}
                  className="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-secondary text-secondary-foreground hover:bg-secondary/80 h-9 px-4 py-2"
                >
                  Settings
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

const PipelinesPage: React.FC = () => {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningPipelines, setRunningPipelines] = useState<Map<string, number>>(new Map());
  const [expandedPipelines, setExpandedPipelines] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  useEffect(() => {
    const fetchPipelines = async () => {
      try {
        const data = await api.listPipelines();
        setPipelines(data.data);
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
      const runningPipelineIds = Array.from(runningPipelines.keys());
      if (runningPipelineIds.length === 0) return;

      try {
        const updatedPipelines = await Promise.all(
          runningPipelineIds.map(async (id) => {
            const response = await api.getPipeline(id);
            return response;
          })
        );

        setPipelines(prev => 
          prev.map(pipeline => {
            const updated = updatedPipelines.find(p => p.id === pipeline.id);
            return updated ? { ...pipeline, ...updated } : pipeline;
          })
        );

        // Remove completed pipelines from running set
        updatedPipelines.forEach(pipeline => {
          if (pipeline.status !== 'running') {
            runningPipelines.delete(pipeline.id);
          }
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
      setRunningPipelines(prev => {
        const next = new Map(prev);
        next.set(pipelineId, Date.now());
        return next;
      });
      
      const data = await api.triggerPipeline(pipelineId, {
        branch: pipelines.find(p => p.id === pipelineId)?.defaultBranch
      });

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
    }
  };

  return (
    <div className="container py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">CI/CD Dashboard</h1>
        <div className="space-x-2">
          <Link
            to="/projects/new"
            className="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700"
          >
            New Project
          </Link>
          <Link
            to="/pipelines/new"
            className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
          >
            New Pipeline
          </Link>
        </div>
      </div>

      <Tabs defaultValue="pipelines" className="w-full">
        <TabsList className="grid w-[400px] grid-cols-2 mb-6">
          <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
        </TabsList>
        
        <TabsContent value="pipelines">
          {loading ? (
            <div className="text-center">Loading pipelines...</div>
          ) : error ? (
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
          ) : pipelines.length === 0 ? (
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
          ) : (
            <div className="space-y-4">
              {pipelines.map((pipeline) => {
                const isExpanded = expandedPipelines.has(pipeline.id);
                const isRunning = runningPipelines.has(pipeline.id) || pipeline.status === 'running';
                
                return (
                  <Card key={pipeline.id}>
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center space-x-3">
                          <h3 className="text-lg font-medium">{pipeline.name}</h3>
                          <StatusBadge 
                            status={pipeline.status} 
                            startTime={pipeline.status === 'running' ? runningPipelines.get(pipeline.id) : undefined} 
                          />
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
          )}
        </TabsContent>

        <TabsContent value="projects">
          <ProjectsList />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default PipelinesPage; 