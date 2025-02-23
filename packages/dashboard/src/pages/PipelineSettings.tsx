import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Terminal, Plus, Pencil, Trash2, GripVertical } from 'lucide-react';
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

interface Step {
  id: string;
  name: string;
  command: string;
  timeout?: number;
  environment?: Record<string, string>;
  dependencies?: string[];
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
}

interface SortableStepItemProps {
  step: Step;
  index: number;
  onEdit: (step: Step) => void;
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
            onClick={() => onEdit(step)}
          >
            <Pencil className="w-4 h-4" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon">
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

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_KEY = import.meta.env.VITE_API_KEY;

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
        const response = await fetch(`${API_URL}/api/pipelines/${id}`, {
          headers: {
            'Accept': 'application/json',
            'x-api-key': API_KEY,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to fetch pipeline');
        }

        const data = await response.json();
        console.log('Fetched pipeline data:', data);
        console.log('Artifact patterns:', data.artifactPatterns);
        setPipeline(data);
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
      const response = await fetch(`${API_URL}/api/pipelines/${id}`, {
        method: 'DELETE',
        headers: {
          'Accept': 'application/json',
          'x-api-key': API_KEY,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to delete pipeline');
      }

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
      const response = await fetch(`${API_URL}/api/pipelines/${id}`, {
        method: 'PUT',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
        },
        body: JSON.stringify(updatedPipeline),
      });

      if (!response.ok) {
        throw new Error('Failed to update pipeline');
      }

      const data = await response.json();
      setPipeline(data);
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

  const handleEditStep = (step: Step) => {
    setEditingStep(step);
    setStepForm({
      name: step.name,
      command: step.command,
      timeout: step.timeout,
    });
    setIsStepDialogOpen(true);
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
    
    const newPatterns = draftPatterns.split('\n').filter(p => p.trim());
    handleUpdatePipeline({
      ...pipeline,
      artifactPatterns: newPatterns
    });
  };

  if (loading) {
    return (
      <div className="container py-8">
        <div className="text-center">Loading pipeline settings...</div>
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

  if (!pipeline) {
    return (
      <div className="container py-8">
        <div className="text-center">Pipeline not found</div>
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
                  {pipeline.steps[0]?.environment && Object.entries(pipeline.steps[0].environment).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between bg-muted p-2 rounded">
                      <div className="text-sm">
                        <span className="font-mono">{key}</span>: {value}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
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
                                  onClick={() => {
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
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Pipeline Steps</CardTitle>
                <CardDescription>Configure and manage your pipeline steps</CardDescription>
              </div>
              <Button onClick={handleAddStep} className="flex items-center gap-2">
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
                  items={pipeline.steps.map(step => step.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="space-y-4">
                    {pipeline.steps.map((step, index) => (
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
                  <Button variant="destructive" disabled={deleteLoading}>
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
              <Button variant="outline" onClick={() => setIsStepDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSaveStep} disabled={isUpdating}>
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