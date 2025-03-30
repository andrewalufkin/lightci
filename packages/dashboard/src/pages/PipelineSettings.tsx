import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Terminal, Plus, Pencil, Trash2, GripVertical, Rocket } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
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
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';

interface Step {
  id: string;
  name: string;
  command: string;
  timeout?: number;
  environment?: Record<string, string>;
  dependencies?: string[];
  runLocation?: string;
}

interface Pipeline {
  id: string;
  name: string;
  repository: string;
  defaultBranch: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  steps: Step[];
  environment?: Record<string, string>;
  artifactsEnabled: boolean;
  artifactPatterns: string[];
  artifactRetentionDays: number;
  artifactStorageType: string;
  artifactStorageConfig: Record<string, any>;
  deploymentEnabled: boolean;
  deploymentMode?: 'automatic' | 'manual';
  deploymentPlatform?: string;
  deploymentConfig?: Record<string, any>;
}

interface SortableStepItemProps {
  step: Step;
  index: number;
  onEdit: (step: Step, e?: React.MouseEvent) => void;
  onDelete: (id: string) => void;
}

const SortableStepItem: React.FC<SortableStepItemProps> = ({ step, index, onEdit, onDelete }) => {
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

  const handleEdit = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onEdit(step, e);
    return false;
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border rounded-lg p-4 bg-background"
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <button
              className="cursor-grab hover:bg-muted p-1 rounded"
              type="button"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="w-4 h-4 text-muted-foreground" />
            </button>
            <h3 className="text-lg font-medium">{step.name}</h3>
          </div>
          <div className="flex items-center text-sm text-muted-foreground mt-2">
            <Terminal className="w-4 h-4 mr-1" />
            <code className="bg-muted px-2 py-1 rounded">{step.command}</code>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-4">
          <div className="text-sm text-muted-foreground">
            Step {index + 1}
          </div>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={handleEdit}
          >
            <Pencil className="w-4 h-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" type="button">
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete step?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove the step "{step.name}" from your pipeline.
                  This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDelete(step.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      {step.timeout && (
        <div className="mt-2 text-sm text-muted-foreground">
          Timeout: {step.timeout}s
        </div>
      )}
    </div>
  );
};

const PipelineSettings: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [isStepDialogOpen, setIsStepDialogOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<Step | null>(null);
  const [stepForm, setStepForm] = useState<Omit<Step, 'id'>>({
    name: '',
    command: '',
    timeout: undefined,
  });
  const [isUpdating, setIsUpdating] = useState(false);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [draftPatterns, setDraftPatterns] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    const fetchPipeline = async () => {
      try {
        const { data } = await api.client.get<{ data: Pipeline }>(`/pipelines/${id}`);
        console.log('Fetched pipeline data:', data.data);
        // Ensure artifactPatterns is always an array
        data.data.artifactPatterns = Array.isArray(data.data.artifactPatterns) ? data.data.artifactPatterns : [];
        console.log('Processed artifact patterns:', data.data.artifactPatterns);
        setPipeline(data.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        console.error('Error fetching pipeline:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchPipeline();
  }, [id]);

  useEffect(() => {
    if (pipeline?.artifactsEnabled) {
      console.log('Artifact settings enabled, pipeline:', pipeline);
    }
  }, [pipeline]);

  const handleDelete = async () => {
    try {
      setDeleteLoading(true);
      await api.client.delete(`/pipelines/${id}`);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete pipeline');
      console.error('Error deleting pipeline:', err);
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleUpdatePipeline = async (updatedPipeline: Pipeline) => {
    try {
      setIsUpdating(true);
      console.log('Updating pipeline with artifact patterns:', updatedPipeline.artifactPatterns);
      const { data } = await api.client.put<{ data: Pipeline }>(`/pipelines/${id}`, updatedPipeline);
      setPipeline(data.data);
      toast.success('Pipeline updated successfully');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update pipeline');
      console.error('Error updating pipeline:', err);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id && pipeline) {
      const oldIndex = pipeline.steps.findIndex((step) => step.id === active.id);
      const newIndex = pipeline.steps.findIndex((step) => step.id === over.id);

      const updatedPipeline = {
        ...pipeline,
        steps: arrayMove(pipeline.steps, oldIndex, newIndex),
      };

      handleUpdatePipeline(updatedPipeline);
    }
  };

  const handleAddStep = () => {
    setEditingStep(null);
    setStepForm({
      name: '',
      command: '',
      timeout: undefined,
    });
    setIsStepDialogOpen(true);
  };

  const handleEditStep = (step: Step, e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    
    // Use a timeout to ensure the event has fully propagated before opening the dialog
    setTimeout(() => {
      setEditingStep(step);
      setStepForm({
        name: step.name,
        command: step.command,
        timeout: step.timeout,
      });
      setIsStepDialogOpen(true);
    }, 0);
    
    return false; // Explicitly return false to prevent default behavior
  };

  const handleDeleteStep = (stepId: string) => {
    if (!pipeline) return;
    
    const updatedPipeline = {
      ...pipeline,
      steps: pipeline.steps.filter(step => step.id !== stepId),
    };
    
    handleUpdatePipeline(updatedPipeline);
  };

  const handleSaveStep = () => {
    if (!pipeline) return;

    const newStep = {
      ...stepForm,
      id: editingStep?.id || `step-${Date.now()}`,
      runLocation: editingStep?.runLocation,
    };

    const updatedPipeline = {
      ...pipeline,
      steps: editingStep
        ? pipeline.steps.map(step => (step.id === editingStep.id ? newStep : step))
        : [...pipeline.steps, newStep],
    };

    handleUpdatePipeline(updatedPipeline);
    setIsStepDialogOpen(false);
  };

  const handleAddEnvironmentVariable = () => {
    if (!pipeline || !newEnvKey.trim() || !newEnvValue.trim()) return;

    const updatedPipeline = {
      ...pipeline,
      steps: pipeline.steps.map((step, index) => ({
        ...step,
        environment: index === 0 ? {
          ...step.environment,
          [newEnvKey]: newEnvValue,
        } : step.environment,
      })),
    };

    handleUpdatePipeline(updatedPipeline);
    setNewEnvKey('');
    setNewEnvValue('');
  };

  const handleRemoveEnvironmentVariable = (key: string) => {
    if (!pipeline) return;

    const updatedPipeline = {
      ...pipeline,
      steps: pipeline.steps.map((step, index) => ({
        ...step,
        environment: index === 0 ? Object.fromEntries(
          Object.entries(step.environment || {}).filter(([k]) => k !== key)
        ) : step.environment,
      })),
    };

    handleUpdatePipeline(updatedPipeline);
  };

  const handleSubmitPatterns = () => {
    if (!pipeline) return;
    
    const newPatterns = draftPatterns
      .split('\n')
      .map(p => p.trim())
      .filter(p => {
        // Basic pattern validation
        if (!p) return false;
        
        try {
          // Test if it's a valid glob pattern
          // Common glob syntax validation
          if (p.includes('..')) return false; // Prevent directory traversal
          if (p.startsWith('/')) return false; // Prevent absolute paths
          if (p.startsWith('\\')) return false; // Prevent Windows absolute paths
          if (p.includes(':')) return false; // Prevent Windows drive letters
          
          // Test if pattern can be used as regex
          new RegExp(p.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'));
          return true;
        } catch (e) {
          console.error('Invalid pattern:', p, e);
          return false;
        }
      });

    if (newPatterns.length === 0) {
      toast.error("Please enter valid artifact patterns");
      return;
    }

    handleUpdatePipeline({
      ...pipeline,
      artifactPatterns: [...new Set([...pipeline.artifactPatterns, ...newPatterns])]
    });
    
    setDraftPatterns('');
    toast.success("Artifact patterns have been updated successfully");
  };

  if (loading) {
    return (
      <div className="container py-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container py-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-col items-center justify-center h-64">
            <div className="text-destructive text-lg mb-4">Error: {error}</div>
            <Button onClick={() => navigate('/')} variant="outline" type="button">
              Return to Pipelines
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!pipeline) {
    return (
      <div className="container py-8">
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-col items-center justify-center h-64">
            <div className="text-muted-foreground text-lg mb-4">Pipeline not found</div>
            <Button onClick={() => navigate('/')} variant="outline" type="button">
              Return to Pipelines
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container py-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-6 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold">{pipeline.name} Settings</h1>
            <p className="text-muted-foreground">
              Manage your pipeline configuration and settings
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => navigate('/')}
            className="flex items-center gap-2"
            type="button"
          >
            ← Back to Pipelines
          </Button>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Pipeline Information</CardTitle>
              <CardDescription>View and manage basic pipeline details</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium">Repository URL</label>
                <div className="text-sm text-muted-foreground">{pipeline.repository}</div>
              </div>
              <div>
                <label className="text-sm font-medium">Description</label>
                <div className="text-sm text-muted-foreground">
                  {pipeline.description || 'No description provided'}
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">Default Branch</label>
                <div className="text-sm text-muted-foreground">{pipeline.defaultBranch}</div>
              </div>
              <div>
                <label className="text-sm font-medium">Created</label>
                <div className="text-sm text-muted-foreground">
                  {new Date(pipeline.createdAt).toLocaleDateString()}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Environment Variables</CardTitle>
              <CardDescription>Configure environment variables for your pipeline</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex gap-2">
                  <Input
                    value={newEnvKey}
                    onChange={(e) => setNewEnvKey(e.target.value)}
                    placeholder="Key"
                  />
                  <Input
                    value={newEnvValue}
                    onChange={(e) => setNewEnvValue(e.target.value)}
                    placeholder="Value"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleAddEnvironmentVariable}
                  >
                    Add
                  </Button>
                </div>
                <div className="space-y-2">
                  {pipeline.steps?.length > 0 && pipeline.steps[0]?.environment && Object.entries(pipeline.steps[0].environment).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between bg-muted p-2 rounded">
                      <div className="text-sm">
                        <span className="font-mono">{key}</span>: {value}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        type="button"
                        onClick={() => handleRemoveEnvironmentVariable(key)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Artifact Settings</CardTitle>
              <CardDescription>Configure how artifacts are handled in your pipeline</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Enable Artifacts</Label>
                  <div className="text-sm text-muted-foreground">
                    Allow this pipeline to store and manage build artifacts
                  </div>
                </div>
                <Switch
                  checked={pipeline?.artifactsEnabled ?? true}
                  onCheckedChange={(checked) => {
                    if (pipeline) {
                      handleUpdatePipeline({
                        ...pipeline,
                        artifactsEnabled: checked
                      });
                    }
                  }}
                />
              </div>

              {pipeline?.artifactsEnabled && (
                <>
                  <div className="space-y-2">
                    <Label>Artifact Patterns</Label>
                    <div className="text-sm text-muted-foreground mb-2">
                      Specify patterns to match files that should be saved as artifacts (one per line)
                    </div>
                    <div className="space-y-4">
                      <div className="bg-muted p-4 rounded-lg">
                        <h4 className="text-sm font-medium mb-2">Current Patterns</h4>
                        {pipeline.artifactPatterns && pipeline.artifactPatterns.length > 0 ? (
                          <div className="space-y-2">
                            {pipeline.artifactPatterns.map((pattern, index) => (
                              <div key={index} className="flex items-center justify-between bg-background p-2 rounded">
                                <code className="text-sm">{pattern}</code>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  type="button"
                                  onClick={(e) => {
                                    if (pipeline) {
                                      const newPatterns = [...pipeline.artifactPatterns];
                                      newPatterns.splice(index, 1);
                                      handleUpdatePipeline({
                                        ...pipeline,
                                        artifactPatterns: newPatterns
                                      });
                                    }
                                  }}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">No patterns configured</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label>Add New Patterns</Label>
                        <Textarea
                          value={draftPatterns}
                          onChange={(e) => setDraftPatterns(e.target.value)}
                          placeholder="Add new patterns (one per line)&#10;Examples:&#10;*.jar&#10;dist/**/*&#10;build/*.zip"
                          className="font-mono min-h-[120px]"
                        />
                        <div className="flex justify-end">
                          <Button
                            onClick={handleSubmitPatterns}
                            disabled={!draftPatterns.trim() || isUpdating}
                            type="button"
                          >
                            {isUpdating ? 'Saving...' : 'Save Patterns'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Retention Period (Days)</Label>
                    <div className="text-sm text-muted-foreground mb-2">
                      Number of days to keep artifacts before automatic deletion
                    </div>
                    <Input
                      type="number"
                      min="1"
                      value={pipeline.artifactRetentionDays}
                      onChange={(e) => {
                        if (pipeline) {
                          handleUpdatePipeline({
                            ...pipeline,
                            artifactRetentionDays: parseInt(e.target.value) || 30
                          });
                        }
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Storage Type</Label>
                    <Select
                      value={pipeline.artifactStorageType}
                      onValueChange={(value) => {
                        if (pipeline) {
                          handleUpdatePipeline({
                            ...pipeline,
                            artifactStorageType: value,
                            artifactStorageConfig: value === 'local' ? {} : pipeline.artifactStorageConfig
                          });
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select storage type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">Local Storage</SelectItem>
                        <SelectItem value="s3">AWS S3</SelectItem>
                        <SelectItem value="gcs">Google Cloud Storage</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {pipeline.artifactStorageType !== 'local' && (
                    <div className="space-y-4 border rounded-lg p-4">
                      <h4 className="font-medium">Storage Configuration</h4>
                      {pipeline.artifactStorageType === 's3' && (
                        <>
                          <div className="space-y-2">
                            <Label>Bucket Name</Label>
                            <Input
                              value={pipeline.artifactStorageConfig.bucketName || ''}
                              onChange={(e) => {
                                if (pipeline) {
                                  handleUpdatePipeline({
                                    ...pipeline,
                                    artifactStorageConfig: {
                                      ...pipeline.artifactStorageConfig,
                                      bucketName: e.target.value
                                    }
                                  });
                                }
                              }}
                              placeholder="my-artifacts-bucket"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Region</Label>
                            <Input
                              value={pipeline.artifactStorageConfig.region || ''}
                              onChange={(e) => {
                                if (pipeline) {
                                  handleUpdatePipeline({
                                    ...pipeline,
                                    artifactStorageConfig: {
                                      ...pipeline.artifactStorageConfig,
                                      region: e.target.value
                                    }
                                  });
                                }
                              }}
                              placeholder="us-east-1"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Credentials ID</Label>
                            <Input
                              value={pipeline.artifactStorageConfig.credentialsId || ''}
                              onChange={(e) => {
                                if (pipeline) {
                                  handleUpdatePipeline({
                                    ...pipeline,
                                    artifactStorageConfig: {
                                      ...pipeline.artifactStorageConfig,
                                      credentialsId: e.target.value
                                    }
                                  });
                                }
                              }}
                              placeholder="my-cloud-credentials"
                            />
                          </div>
                        </>
                      )}
                      {pipeline.artifactStorageType === 'gcs' && (
                        <>
                          <div className="space-y-2">
                            <Label>Bucket Name</Label>
                            <Input
                              value={pipeline.artifactStorageConfig.bucketName || ''}
                              onChange={(e) => {
                                if (pipeline) {
                                  handleUpdatePipeline({
                                    ...pipeline,
                                    artifactStorageConfig: {
                                      ...pipeline.artifactStorageConfig,
                                      bucketName: e.target.value
                                    }
                                  });
                                }
                              }}
                              placeholder="my-artifacts-bucket"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Project ID</Label>
                            <Input
                              value={pipeline.artifactStorageConfig.projectId || ''}
                              onChange={(e) => {
                                if (pipeline) {
                                  handleUpdatePipeline({
                                    ...pipeline,
                                    artifactStorageConfig: {
                                      ...pipeline.artifactStorageConfig,
                                      projectId: e.target.value
                                    }
                                  });
                                }
                              }}
                              placeholder="my-gcp-project"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label>Service Account Key</Label>
                            <Input
                              value={pipeline.artifactStorageConfig.serviceAccountKey || ''}
                              onChange={(e) => {
                                if (pipeline) {
                                  handleUpdatePipeline({
                                    ...pipeline,
                                    artifactStorageConfig: {
                                      ...pipeline.artifactStorageConfig,
                                      serviceAccountKey: e.target.value
                                    }
                                  });
                                }
                              }}
                              placeholder="my-service-account-key"
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Rocket className="w-5 h-5 text-primary" />
                <div>
                  <CardTitle>Deployment Settings</CardTitle>
                  <CardDescription>Configure deployment options for your pipeline</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Enable Deployment</Label>
                  <div className="text-sm text-muted-foreground">
                    Configure automated deployment for this pipeline
                  </div>
                </div>
                <Switch
                  checked={pipeline?.deploymentEnabled ?? false}
                  onCheckedChange={(checked) => {
                    if (pipeline) {
                      handleUpdatePipeline({
                        ...pipeline,
                        deploymentEnabled: checked,
                        deploymentMode: checked ? 'automatic' : undefined
                      });
                    }
                  }}
                />
              </div>

              {pipeline?.deploymentEnabled && (
                <>
                  <div className="space-y-2">
                    <Label>Deployment Mode</Label>
                    <Select
                      value={pipeline.deploymentMode || 'automatic'}
                      onValueChange={(value: 'automatic' | 'manual') => {
                        if (pipeline) {
                          handleUpdatePipeline({
                            ...pipeline,
                            deploymentMode: value
                          });
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select deployment mode" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="automatic">
                          <div className="flex flex-col">
                            <span>Automatic Deployment</span>
                            <span className="text-sm text-muted-foreground">Deploy automatically after successful pipeline run</span>
                          </div>
                        </SelectItem>
                        <SelectItem value="manual">
                          <div className="flex flex-col">
                            <span>Manual Deployment</span>
                            <span className="text-sm text-muted-foreground">Configure deployment settings manually</span>
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {pipeline.deploymentMode === 'manual' && (
                    <>
                      <div className="space-y-2">
                        <Label>Deployment Platform</Label>
                        <Select
                          value={pipeline.deploymentPlatform || 'aws'}
                          onValueChange={(value) => {
                            if (pipeline) {
                              handleUpdatePipeline({
                                ...pipeline,
                                deploymentPlatform: value,
                                deploymentConfig: {}
                              });
                            }
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select deployment platform" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="aws">AWS</SelectItem>
                            <SelectItem value="gcp">Google Cloud Platform</SelectItem>
                            <SelectItem value="azure">Azure</SelectItem>
                            <SelectItem value="kubernetes">Kubernetes</SelectItem>
                            <SelectItem value="custom">Custom</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      
                      <div className="space-y-4 border rounded-lg p-4">
                        <h4 className="font-medium">Deployment Configuration</h4>
                        
                        {pipeline.deploymentPlatform === 'aws' && (
                          <>
                            <div className="space-y-2">
                              <Label>AWS Region</Label>
                              <Input
                                value={pipeline.deploymentConfig?.region || ''}
                                onChange={(e) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        region: e.target.value
                                      }
                                    });
                                  }
                                }}
                                placeholder="us-east-1"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>AWS Service</Label>
                              <Select
                                value={pipeline.deploymentConfig?.service || 'lambda'}
                                onValueChange={(value) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        service: value
                                      }
                                    });
                                  }
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select AWS service" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="lambda">Lambda</SelectItem>
                                  <SelectItem value="ecs">ECS</SelectItem>
                                  <SelectItem value="ec2">EC2</SelectItem>
                                  <SelectItem value="s3">S3 Static Website</SelectItem>
                                  <SelectItem value="elasticbeanstalk">Elastic Beanstalk</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <Label>Credentials ID</Label>
                              <Input
                                value={pipeline.deploymentConfig?.credentials || ''}
                                onChange={(e) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        credentials: e.target.value
                                      }
                                    });
                                  }
                                }}
                                placeholder="aws-credentials"
                              />
                            </div>
                          </>
                        )}
                        
                        {pipeline.deploymentPlatform === 'gcp' && (
                          <>
                            <div className="space-y-2">
                              <Label>GCP Region</Label>
                              <Input
                                value={pipeline.deploymentConfig?.region || ''}
                                onChange={(e) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        region: e.target.value
                                      }
                                    });
                                  }
                                }}
                                placeholder="us-central1"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>GCP Service</Label>
                              <Select
                                value={pipeline.deploymentConfig?.service || 'cloudfunctions'}
                                onValueChange={(value) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        service: value
                                      }
                                    });
                                  }
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select GCP service" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="cloudfunctions">Cloud Functions</SelectItem>
                                  <SelectItem value="cloudrun">Cloud Run</SelectItem>
                                  <SelectItem value="gke">GKE</SelectItem>
                                  <SelectItem value="appengine">App Engine</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <Label>Credentials ID</Label>
                              <Input
                                value={pipeline.deploymentConfig?.credentials || ''}
                                onChange={(e) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        credentials: e.target.value
                                      }
                                    });
                                  }
                                }}
                                placeholder="gcp-credentials"
                              />
                            </div>
                          </>
                        )}
                        
                        {pipeline.deploymentPlatform === 'azure' && (
                          <>
                            <div className="space-y-2">
                              <Label>Azure Region</Label>
                              <Input
                                value={pipeline.deploymentConfig?.region || ''}
                                onChange={(e) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        region: e.target.value
                                      }
                                    });
                                  }
                                }}
                                placeholder="eastus"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Azure Service</Label>
                              <Select
                                value={pipeline.deploymentConfig?.service || 'functions'}
                                onValueChange={(value) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        service: value
                                      }
                                    });
                                  }
                                }}
                              >
                                <SelectTrigger>
                                  <SelectValue placeholder="Select Azure service" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="functions">Azure Functions</SelectItem>
                                  <SelectItem value="appservice">App Service</SelectItem>
                                  <SelectItem value="aks">AKS</SelectItem>
                                  <SelectItem value="containerinstances">Container Instances</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <Label>Credentials ID</Label>
                              <Input
                                value={pipeline.deploymentConfig?.credentials || ''}
                                onChange={(e) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        credentials: e.target.value
                                      }
                                    });
                                  }
                                }}
                                placeholder="azure-credentials"
                              />
                            </div>
                          </>
                        )}
                        
                        {pipeline.deploymentPlatform === 'kubernetes' && (
                          <>
                            <div className="space-y-2">
                              <Label>Kubernetes Cluster</Label>
                              <Input
                                value={pipeline.deploymentConfig?.cluster || ''}
                                onChange={(e) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        cluster: e.target.value
                                      }
                                    });
                                  }
                                }}
                                placeholder="my-cluster"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Namespace</Label>
                              <Input
                                value={pipeline.deploymentConfig?.namespace || ''}
                                onChange={(e) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        namespace: e.target.value
                                      }
                                    });
                                  }
                                }}
                                placeholder="default"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Credentials ID</Label>
                              <Input
                                value={pipeline.deploymentConfig?.credentials || ''}
                                onChange={(e) => {
                                  if (pipeline) {
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        credentials: e.target.value
                                      }
                                    });
                                  }
                                }}
                                placeholder="kubeconfig"
                              />
                            </div>
                          </>
                        )}
                        
                        {pipeline.deploymentPlatform === 'custom' && (
                          <div className="space-y-4">
                            <div className="space-y-2">
                              <Label>Custom Configuration</Label>
                              <div className="text-sm text-muted-foreground mb-2">
                                Define custom deployment settings as key-value pairs. These will be available as environment variables in your deployment step.
                              </div>
                              <Textarea
                                value={Object.entries(pipeline.deploymentConfig?.customSettings || {})
                                  .map(([key, value]) => `${key}=${value}`)
                                  .join('\n')}
                                onChange={(e) => {
                                  if (pipeline) {
                                    const customSettings = e.target.value
                                      .split('\n')
                                      .filter(line => line.includes('='))
                                      .reduce((acc, line) => {
                                        const [key, value] = line.split('=');
                                        if (key && value) {
                                          acc[key.trim()] = value.trim();
                                        }
                                        return acc;
                                      }, {} as Record<string, string>);
                                    
                                    handleUpdatePipeline({
                                      ...pipeline,
                                      deploymentConfig: {
                                        ...pipeline.deploymentConfig,
                                        customSettings
                                      }
                                    });
                                  }
                                }}
                                placeholder="KEY=value (one per line)&#10;Example:&#10;DEPLOY_TARGET=production&#10;USE_CDN=true"
                                className="font-mono min-h-[120px]"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Pipeline Steps</CardTitle>
                <CardDescription>Configure and manage your pipeline steps</CardDescription>
              </div>
              <Button onClick={handleAddStep} className="flex items-center gap-2" type="button">
                <Plus className="w-4 h-4" /> Add Step
              </Button>
            </CardHeader>
            <CardContent>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={(pipeline.steps || []).map(step => step.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-4">
                    {(pipeline.steps || []).map((step, index) => (
                      <SortableStepItem
                        key={step.id}
                        step={step}
                        index={index}
                        onEdit={handleEditStep}
                        onDelete={handleDeleteStep}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </CardContent>
          </Card>

          <Card className="border-destructive">
            <CardHeader>
              <CardTitle className="text-destructive">Danger Zone</CardTitle>
              <CardDescription>
                Destructive actions that cannot be undone
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" disabled={deleteLoading} type="button">
                    {deleteLoading ? 'Deleting...' : 'Delete Pipeline'}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. This will permanently delete the
                      pipeline and all associated builds and artifacts.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={handleDelete}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </CardContent>
          </Card>
        </div>

        <Dialog open={isStepDialogOpen} onOpenChange={setIsStepDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingStep ? 'Edit Step' : 'Add Step'}</DialogTitle>
              <DialogDescription>
                Configure your pipeline step details
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={stepForm.name}
                  onChange={(e) => setStepForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Step name"
                />
              </div>
              <div className="space-y-2">
                <Label>Command</Label>
                <Textarea
                  value={stepForm.command}
                  onChange={(e) => setStepForm(prev => ({ ...prev, command: e.target.value }))}
                  placeholder="Command to execute"
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label>Timeout (seconds)</Label>
                <Input
                  type="number"
                  value={stepForm.timeout || ''}
                  onChange={(e) => setStepForm(prev => ({ ...prev, timeout: e.target.value ? parseInt(e.target.value) : undefined }))}
                  placeholder="Optional timeout in seconds"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsStepDialogOpen(false)} type="button">
                Cancel
              </Button>
              <Button onClick={handleSaveStep} disabled={isUpdating} type="button">
                {isUpdating ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default PipelineSettings; 