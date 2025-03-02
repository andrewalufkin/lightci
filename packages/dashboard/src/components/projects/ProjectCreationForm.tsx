import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/services/api';
import { toast } from 'sonner';

interface Pipeline {
  id: string;
  name: string;
  description?: string;
}

interface ProjectFormData {
  name: string;
  description: string;
  visibility: 'private' | 'public';
  pipelineIds: string[];
}

const ProjectCreationForm: React.FC = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState<ProjectFormData>({
    name: '',
    description: '',
    visibility: 'private',
    pipelineIds: [],
  });
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fetchPipelines = async () => {
      try {
        const response = await api.listPipelines();
        setPipelines(response.data);
      } catch (error) {
        console.error('Error fetching pipelines:', error);
        toast.error('Failed to load pipelines');
      }
    };

    fetchPipelines();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      await api.createProject(formData);
      toast.success('Project created successfully');
      navigate('/');
    } catch (error) {
      console.error('Error creating project:', error);
      toast.error('Failed to create project');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePipelineToggle = (pipelineId: string) => {
    setFormData(prev => ({
      ...prev,
      pipelineIds: prev.pipelineIds.includes(pipelineId)
        ? prev.pipelineIds.filter(id => id !== pipelineId)
        : [...prev.pipelineIds, pipelineId]
    }));
  };

  return (
    <div className="container mx-auto py-6">
      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold">Create Project</h1>
          <div className="space-x-2">
            <Button variant="outline" type="button" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Project'}
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Project Details</CardTitle>
            <CardDescription>
              Enter the basic information for your new project
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Project Name</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="My Project"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Project description"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="visibility">Visibility</Label>
              <Select
                value={formData.visibility}
                onValueChange={(value: 'private' | 'public') => 
                  setFormData(prev => ({ ...prev, visibility: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select visibility" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private</SelectItem>
                  <SelectItem value="public">Public</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Pipelines</Label>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {pipelines.map((pipeline) => (
                  <Card
                    key={pipeline.id}
                    className={`cursor-pointer transition-all ${
                      formData.pipelineIds.includes(pipeline.id)
                        ? 'border-primary'
                        : ''
                    }`}
                    onClick={() => handlePipelineToggle(pipeline.id)}
                  >
                    <CardHeader>
                      <CardTitle className="text-sm">{pipeline.name}</CardTitle>
                      {pipeline.description && (
                        <CardDescription className="text-xs">
                          {pipeline.description}
                        </CardDescription>
                      )}
                    </CardHeader>
                  </Card>
                ))}
              </div>
              {pipelines.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No pipelines available. Create a pipeline first.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
};

export default ProjectCreationForm; 