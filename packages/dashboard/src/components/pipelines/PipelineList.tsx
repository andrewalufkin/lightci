import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { GitBranch, Play, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import type { Pipeline } from '@/types/api';

const PipelineList = () => {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPipelines = async () => {
      try {
        const data = await api.listPipelines();
        setPipelines(data.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        console.error('Error fetching pipelines:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchPipelines();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[200px]">
        <div className="animate-pulse">Loading pipelines...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-red-500 p-4 rounded-md bg-red-50">
        Error: {error}
      </div>
    );
  }

  if (pipelines.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-8 text-center">
          <div className="text-muted-foreground mb-4">No pipelines found</div>
          <Link to="/pipelines/new">
            <Button>Create Your First Pipeline</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {pipelines.map((pipeline) => (
        <Card key={pipeline.id} className="hover:border-primary transition-colors">
          <CardHeader>
            <div className="flex justify-between items-start">
              <div>
                <CardTitle>{pipeline.name}</CardTitle>
                <CardDescription>{pipeline.description || 'No description'}</CardDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm">
                  <Play className="h-4 w-4 mr-1" />
                  Run
                </Button>
                <Link to={`/pipelines/${pipeline.id}`}>
                  <Button variant="outline" size="sm">View Details</Button>
                </Link>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4 text-sm text-muted-foreground">
              <div className="flex items-center">
                <GitBranch className="h-4 w-4 mr-1" />
                {pipeline.repository}
              </div>
              <div className="flex items-center">
                <Clock className="h-4 w-4 mr-1" />
                Last updated: {new Date(pipeline.updatedAt).toLocaleString()}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

export default PipelineList; 