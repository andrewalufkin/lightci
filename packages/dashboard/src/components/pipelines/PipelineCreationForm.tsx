import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { GitBranch, Settings, Play, Clock, List } from 'lucide-react';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Terminal } from 'lucide-react';

interface PipelineStep {
  id: string;
  name: string;
  description: string;
  command: string;
  type: 'source' | 'build' | 'test' | 'deploy' | 'custom';
}

interface PipelineFormData {
  repositoryUrl: string;
  branch: string;
  authType: string;
  name: string;
  description: string;
  environmentVariables: { key: string; value: string }[];
  triggers: {
    onPush: boolean;
    onPullRequest: boolean;
    onTag: boolean;
  };
  schedule: {
    cron: string;
    timezone: string;
  };
  steps: PipelineStep[];
}

interface PipelineApiPayload {
  name: string;
  repository: string;
  description?: string;
  steps: {
    name: string;
    command: string;
    timeout?: number;
    environment?: Record<string, string>;
  }[];
  defaultBranch: string;
  triggers?: {
    branches?: string[];
    events?: ('push' | 'pull_request')[];
  };
}

interface StepFormData {
  name: string;
  description: string;
  command: string;
  type: 'source' | 'build' | 'test' | 'deploy' | 'custom';
}

const defaultSteps: PipelineStep[] = [
  {
    id: 'source',
    name: 'Source',
    description: 'Clone and prepare source code',
    command: 'git clone $REPO_URL .',
    type: 'source',
  }
];

const templateSteps: Record<string, PipelineStep[]> = {
  nodejs: [
    {
      id: 'build',
      name: 'Build',
      description: 'Compile and package application',
      command: 'npm install && npm run build',
      type: 'build',
    },
    {
      id: 'test',
      name: 'Test',
      description: 'Run test suite',
      command: 'npm test',
      type: 'test',
    },
    {
      id: 'deploy',
      name: 'Deploy',
      description: 'Deploy to production',
      command: 'docker build -t myapp . && docker push myapp',
      type: 'deploy',
    },
  ],
  rust: [
    {
      id: 'build',
      name: 'Build',
      description: 'Compile Rust project',
      command: 'cargo build --release',
      type: 'build',
    },
    {
      id: 'test',
      name: 'Test',
      description: 'Run test suite',
      command: 'cargo test',
      type: 'test',
    },
  ],
  docker: [
    {
      id: 'build',
      name: 'Build',
      description: 'Build Docker image',
      command: 'docker build -t $IMAGE_NAME .',
      type: 'build',
    },
    {
      id: 'test',
      name: 'Test',
      description: 'Run container tests',
      command: 'docker run --rm $IMAGE_NAME test',
      type: 'test',
    },
    {
      id: 'deploy',
      name: 'Deploy',
      description: 'Push Docker image',
      command: 'docker push $IMAGE_NAME',
      type: 'deploy',
    },
  ],
};

// Add API URL and key configuration
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_KEY = import.meta.env.VITE_API_KEY;

// Add validation functions
const validateGitHubRepo = async (url: string): Promise<boolean> => {
  try {
    // Extract owner and repo from GitHub URL
    const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) return false;
    
    const [, owner, repo] = match;
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
    return response.ok;
  } catch {
    return false;
  }
};

const validateGitHubBranch = async (url: string, branch: string): Promise<boolean> => {
  try {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) return false;
    
    const [, owner, repo] = match;
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${branch}`);
    return response.ok;
  } catch {
    return false;
  }
};

// Add repository URL validation
const isValidGitUrl = (url: string) => {
  try {
    new URL(url);
    return url.endsWith('.git') || url.includes('github.com/');
  } catch {
    return false;
  }
};

// Add timezone list
const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
  'Pacific/Auckland'
].sort();

interface SortableStepItemProps {
  step: PipelineStep;
  index: number;
  onEdit: (step: PipelineStep) => void;
  onDelete: (id: string) => void;
  environmentVariables: { key: string; value: string }[];
}

const SortableStepItem: React.FC<SortableStepItemProps> = ({ 
  step, 
  index, 
  onEdit, 
  onDelete,
  environmentVariables 
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <Card ref={setNodeRef} style={style}>
      <CardHeader className="p-4">
        <div className="flex justify-between items-start">
          <div className="flex items-start gap-2">
            {step.type !== 'source' && (
              <button
                className="cursor-grab hover:bg-muted p-1 rounded mt-1"
                {...attributes}
                {...listeners}
              >
                <GripVertical className="w-4 h-4 text-muted-foreground" />
              </button>
            )}
            <div>
              <CardTitle className="text-sm">{step.name}</CardTitle>
              <CardDescription className="text-xs">{step.description}</CardDescription>
            </div>
          </div>
          <div className="flex gap-2">
            <Button 
              variant="ghost" 
              size="sm"
              onClick={() => onEdit(step)}
            >
              Edit
            </Button>
            {step.type !== 'source' && (
              <Button 
                variant="ghost" 
                size="sm" 
                className="text-red-500"
                onClick={() => onDelete(step.id)}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
        <div className="mt-2">
          <div className="flex items-center text-sm text-muted-foreground">
            <Terminal className="w-4 h-4 mr-1" />
            <code className="bg-muted px-2 py-1 rounded">{step.command}</code>
          </div>
          {step.type === 'source' && environmentVariables.length > 0 && (
            <div className="mt-2">
              <h4 className="text-sm font-medium mb-1">Environment Variables Available</h4>
              <div className="grid grid-cols-2 gap-2">
                {environmentVariables.map(({ key, value }) => (
                  <div key={key} className="text-sm">
                    <span className="font-mono">{key}</span>: {value}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardHeader>
    </Card>
  );
};

const PipelineCreationForm = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState<PipelineFormData>({
    repositoryUrl: '',
    branch: 'main',
    authType: 'SSH Key',
    name: '',
    description: '',
    environmentVariables: [],
    triggers: {
      onPush: false,
      onPullRequest: false,
      onTag: false,
    },
    schedule: {
      cron: '',
      timezone: 'UTC',
    },
    steps: defaultSteps,
  });

  const [newEnvVar, setNewEnvVar] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [isStepDialogOpen, setIsStepDialogOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<PipelineStep | null>(null);
  const [stepForm, setStepForm] = useState<StepFormData>({
    name: '',
    description: '',
    command: '',
    type: 'custom'
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleInputChange = (field: keyof PipelineFormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleTriggerChange = (trigger: keyof PipelineFormData['triggers']) => {
    setFormData((prev) => ({
      ...prev,
      triggers: { ...prev.triggers, [trigger]: !prev.triggers[trigger] },
    }));
  };

  const handleAddEnvVar = () => {
    const [key, value] = newEnvVar.split('=').map((s) => s.trim());
    if (key && value) {
      // Check for duplicate key
      if (formData.environmentVariables.some(env => env.key === key)) {
        alert(`Environment variable "${key}" already exists`);
        return;
      }
      
      setFormData((prev) => ({
        ...prev,
        environmentVariables: [...prev.environmentVariables, { key, value }],
      }));
      setNewEnvVar('');
    } else {
      alert('Please enter both key and value in the format KEY=value');
    }
  };

  const handleTemplateSelect = (templateName: keyof typeof templateSteps) => {
    setFormData((prev) => ({
      ...prev,
      steps: [...defaultSteps, ...templateSteps[templateName]],
    }));
  };

  const handleRemoveStep = (stepId: string) => {
    setFormData((prev) => ({
      ...prev,
      steps: prev.steps.filter((step) => step.id !== stepId),
    }));
  };

  const handleAddStep = () => {
    setEditingStep(null);
    setStepForm({
      name: '',
      description: '',
      command: '',
      type: 'custom'
    });
    setIsStepDialogOpen(true);
  };

  const handleEditStep = (step: PipelineStep) => {
    setEditingStep(step);
    setStepForm({
      name: step.name,
      description: step.description,
      command: step.command,
      type: step.type
    });
    setIsStepDialogOpen(true);
  };

  const handleStepSubmit = () => {
    if (editingStep) {
      // Update existing step
      setFormData(prev => ({
        ...prev,
        steps: prev.steps.map(step => 
          step.id === editingStep.id 
            ? { ...stepForm, id: step.id }
            : step
        )
      }));
    } else {
      // Add new step
      const newStep: PipelineStep = {
        ...stepForm,
        id: crypto.randomUUID()
      };
      setFormData(prev => ({
        ...prev,
        steps: [...prev.steps, newStep]
      }));
    }
    setIsStepDialogOpen(false);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      setFormData((prev) => {
        const oldIndex = prev.steps.findIndex((step) => step.id === active.id);
        const newIndex = prev.steps.findIndex((step) => step.id === over.id);

        // Don't allow moving the source step
        if (oldIndex === 0 || newIndex === 0) return prev;

        return {
          ...prev,
          steps: arrayMove(prev.steps, oldIndex, newIndex),
        };
      });
    }
  };

  const transformFormToApiPayload = (): PipelineApiPayload => {
    const envVars = formData.environmentVariables.reduce(
      (acc, { key, value }) => ({ ...acc, [key]: value }),
      {} as Record<string, string>
    );

    const events: ('push' | 'pull_request')[] = [];
    if (formData.triggers.onPush) events.push('push');
    if (formData.triggers.onPullRequest) events.push('pull_request');

    const apiSteps = formData.steps.map(step => ({
      name: step.name,
      command: step.command,
      environment: step.type === 'source' ? envVars : undefined,
      timeout: 3600
    }));

    return {
      name: formData.name,
      repository: formData.repositoryUrl,
      description: formData.description,
      defaultBranch: formData.branch,
      steps: apiSteps,
      triggers: {
        events,
        branches: [formData.branch]
      }
    };
  };

  const handleSubmit = async () => {
    try {
      setSubmitting(true);
      
      // Improved validation
      if (!formData.name) {
        alert('Pipeline name is required');
        setSubmitting(false);
        return;
      }
      if (!formData.repositoryUrl) {
        alert('Repository URL is required');
        setSubmitting(false);
        return;
      }
      if (!isValidGitUrl(formData.repositoryUrl)) {
        alert('Please enter a valid Git repository URL (e.g., https://github.com/username/repo.git)');
        setSubmitting(false);
        return;
      }

      // Validate GitHub repository
      const isValidRepo = await validateGitHubRepo(formData.repositoryUrl);
      if (!isValidRepo) {
        alert('Repository not found. Please check the URL and ensure you have access to it.');
        setSubmitting(false);
        return;
      }

      // Validate branch
      const isValidBranch = await validateGitHubBranch(formData.repositoryUrl, formData.branch);
      if (!isValidBranch) {
        alert(`Branch "${formData.branch}" not found in the repository.`);
        setSubmitting(false);
        return;
      }

      if (formData.steps.length === 0) {
        alert('At least one step is required');
        setSubmitting(false);
        return;
      }

      const apiPayload = transformFormToApiPayload();
      console.log('Submitting pipeline with payload:', apiPayload);

      // Use configured API URL
      const response = await fetch(`${API_URL}/api/pipelines`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-key': API_KEY,
        },
        body: JSON.stringify(apiPayload),
      });

      // Log the raw response for debugging
      console.log('Raw Response:', {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      });

      let responseData;
      const responseText = await response.text();
      console.log('Raw response text:', responseText);

      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        console.error('Failed to parse response as JSON:', e);
        responseData = { message: 'Invalid server response' };
      }

      console.log('API Response:', {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        data: responseData
      });

      if (response.ok) {
        navigate('/');
      } else {
        let errorMessage = 'Failed to create pipeline';
        
        if (responseData.message) {
          errorMessage += `: ${responseData.message}`;
        }
        
        if (responseData.errors) {
          errorMessage += '\nValidation errors:\n';
          errorMessage += Object.entries(responseData.errors)
            .map(([field, error]) => `- ${field}: ${error}`)
            .join('\n');
        }

        console.error('Pipeline creation failed:', {
          status: response.status,
          error: responseData,
          request: {
            url: `${API_URL}/api/pipelines`,
            payload: apiPayload
          }
        });

        alert(errorMessage);
      }
    } catch (error) {
      console.error('Error creating pipeline:', {
        error,
        formData,
        apiPayload: transformFormToApiPayload(),
        request: {
          url: `${API_URL}/api/pipelines`
        }
      });
      
      if (error instanceof Error) {
        alert(`Failed to create pipeline: ${error.message}\nCheck the console for more details.`);
      } else {
        alert('Failed to create pipeline. Check the console for more details.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <Card>
        <CardHeader>
          <CardTitle>Create New Pipeline</CardTitle>
          <CardDescription>Configure your pipeline settings and build steps</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="source" className="space-y-4">
            <TabsList>
              <TabsTrigger value="source" className="flex items-center gap-2">
                <GitBranch size={16} />
                Source
              </TabsTrigger>
              <TabsTrigger value="config" className="flex items-center gap-2">
                <Settings size={16} />
                Configuration
              </TabsTrigger>
              <TabsTrigger value="triggers" className="flex items-center gap-2">
                <Play size={16} />
                Triggers
              </TabsTrigger>
              <TabsTrigger value="schedule" className="flex items-center gap-2">
                <Clock size={16} />
                Schedule
              </TabsTrigger>
              <TabsTrigger value="steps" className="flex items-center gap-2">
                <List size={16} />
                Steps
              </TabsTrigger>
            </TabsList>

            <TabsContent value="source" className="space-y-4">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Repository URL</label>
                  <Input
                    placeholder="https://github.com/username/repo"
                    value={formData.repositoryUrl}
                    onChange={(e) => handleInputChange('repositoryUrl', e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Branch</label>
                  <Input
                    placeholder="main"
                    value={formData.branch}
                    onChange={(e) => handleInputChange('branch', e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Authentication</label>
                  <select
                    className="w-full p-2 border rounded"
                    value={formData.authType}
                    onChange={(e) => handleInputChange('authType', e.target.value)}
                  >
                    <option>SSH Key</option>
                    <option>Personal Access Token</option>
                    <option>OAuth</option>
                  </select>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="config" className="space-y-4">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Pipeline Name</label>
                  <Input
                    placeholder="My Pipeline"
                    value={formData.name}
                    onChange={(e) => handleInputChange('name', e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Description</label>
                  <Input
                    placeholder="Description of your pipeline"
                    value={formData.description}
                    onChange={(e) => handleInputChange('description', e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Environment Variables</label>
                  <div className="space-y-2">
                    <Input
                      placeholder="KEY=value"
                      value={newEnvVar}
                      onChange={(e) => setNewEnvVar(e.target.value)}
                    />
                    <Button variant="outline" className="w-full" onClick={handleAddEnvVar}>
                      Add Variable
                    </Button>
                  </div>
                  {formData.environmentVariables.length > 0 && (
                    <div className="mt-2 space-y-2">
                      {formData.environmentVariables.map(({ key, value }, index) => (
                        <div key={index} className="flex items-center justify-between bg-muted p-2 rounded">
                          <span>{key}={value}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setFormData((prev) => ({
                                ...prev,
                                environmentVariables: prev.environmentVariables.filter((_, i) => i !== index),
                              }))
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="triggers" className="space-y-4">
              <div className="space-y-2">
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={formData.triggers.onPush}
                    onChange={() => handleTriggerChange('onPush')}
                  />
                  <span>On Push</span>
                </label>
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={formData.triggers.onPullRequest}
                    onChange={() => handleTriggerChange('onPullRequest')}
                  />
                  <span>On Pull Request</span>
                </label>
                <label className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    checked={formData.triggers.onTag}
                    onChange={() => handleTriggerChange('onTag')}
                  />
                  <span>On Tag Creation</span>
                </label>
              </div>
            </TabsContent>

            <TabsContent value="schedule" className="space-y-4">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">Cron Schedule</label>
                  <Input
                    placeholder="0 0 * * *"
                    value={formData.schedule.cron}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        schedule: { ...prev.schedule, cron: e.target.value },
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Timezone</label>
                  <select
                    className="w-full p-2 border rounded"
                    value={formData.schedule.timezone}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        schedule: { ...prev.schedule, timezone: e.target.value },
                      }))
                    }
                  >
                    {TIMEZONES.map(tz => (
                      <option key={tz} value={tz}>{tz}</option>
                    ))}
                  </select>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="steps" className="space-y-4">
              <div className="space-y-4">
                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2">Quick Start Templates</label>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <Card 
                      className="cursor-pointer hover:border-blue-500 transition-all"
                      onClick={() => handleTemplateSelect('nodejs')}
                    >
                      <CardHeader className="p-4">
                        <CardTitle className="text-sm">Node.js Build</CardTitle>
                        <CardDescription className="text-xs">Build, test, and deploy Node.js apps</CardDescription>
                      </CardHeader>
                    </Card>
                    <Card 
                      className="cursor-pointer hover:border-blue-500 transition-all"
                      onClick={() => handleTemplateSelect('rust')}
                    >
                      <CardHeader className="p-4">
                        <CardTitle className="text-sm">Rust Project</CardTitle>
                        <CardDescription className="text-xs">Cargo build, test, and binary creation</CardDescription>
                      </CardHeader>
                    </Card>
                    <Card 
                      className="cursor-pointer hover:border-blue-500 transition-all"
                      onClick={() => handleTemplateSelect('docker')}
                    >
                      <CardHeader className="p-4">
                        <CardTitle className="text-sm">Docker Build</CardTitle>
                        <CardDescription className="text-xs">Build and push Docker images</CardDescription>
                      </CardHeader>
                    </Card>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between items-center mb-4">
                    <label className="block text-sm font-medium">Pipeline Steps</label>
                    <Button variant="outline" size="sm" onClick={handleAddStep}>Add Step</Button>
                  </div>
                  
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={formData.steps.map(step => step.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-4">
                        {formData.steps.map((step, index) => (
                          <SortableStepItem
                            key={step.id}
                            step={step}
                            index={index}
                            onEdit={handleEditStep}
                            onDelete={handleRemoveStep}
                            environmentVariables={formData.environmentVariables}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <AlertDialog open={isStepDialogOpen} onOpenChange={setIsStepDialogOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{editingStep ? 'Edit Step' : 'Add Step'}</AlertDialogTitle>
                <AlertDialogDescription>
                  Configure your pipeline step details
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Step Type</label>
                  <select
                    className="w-full p-2 border rounded"
                    value={stepForm.type}
                    onChange={(e) => setStepForm(prev => ({ ...prev, type: e.target.value as PipelineStep['type'] }))}
                  >
                    <option value="build">Build</option>
                    <option value="test">Test</option>
                    <option value="deploy">Deploy</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Name</label>
                  <Input
                    value={stepForm.name}
                    onChange={(e) => setStepForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="Step name"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Description</label>
                  <Input
                    value={stepForm.description}
                    onChange={(e) => setStepForm(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="Step description"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Command</label>
                  <Input
                    value={stepForm.command}
                    onChange={(e) => setStepForm(prev => ({ ...prev, command: e.target.value }))}
                    placeholder="Command to execute"
                  />
                </div>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleStepSubmit}>
                  {editingStep ? 'Save Changes' : 'Add Step'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <div className="mt-6 flex justify-end space-x-2">
            <Button variant="outline" onClick={() => navigate('/')} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Creating Pipeline...' : 'Create Pipeline'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default PipelineCreationForm; 