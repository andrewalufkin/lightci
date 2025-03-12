import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { GitBranch, Settings, Play, Clock, List, Package, Plus, Trash2, Rocket } from 'lucide-react';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
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
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/services/api';

interface BlueGreenConfig {
  productionPort: number;
  stagingPort: number;
  healthCheckPath: string;
  healthCheckTimeout: number;
  rollbackOnFailure: boolean;
}

interface DeploymentConfig {
  enabled: boolean;
  platform: 'aws' | 'gcp' | 'azure' | 'kubernetes' | 'custom';
  strategy: 'standard' | 'blue-green';
  config: {
    // Common fields
    region?: string;
    service?: string;
    cluster?: string;
    namespace?: string;
    credentials?: string;
    customSettings?: Record<string, string>;
    // Blue/Green deployment fields
    blueGreenConfig?: BlueGreenConfig;
    // AWS EC2 specific fields
    awsRegion?: string; // For backward compatibility
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    ec2InstanceId?: string;
    ec2DeployPath?: string;
    ec2SshKey?: string;
    ec2Username?: string;
    // Environment variables
    environmentVariables?: Record<string, string>;
  };
}

interface PipelineStep {
  id: string;
  name: string;
  description: string;
  command: string;
  type: 'source' | 'build' | 'test' | 'deploy' | 'custom';
  automatic?: boolean;
  runOnDeployedInstance?: boolean;
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
      command: 'npm install ts-node --save-dev && npm install && npm run build',
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
      id: 'deployment',
      name: 'Deployment',
      description: 'Deploy application to target environment',
      command: 'pkill -f "node.*src/server.js" || true && npm install && npm start',
      type: 'deploy',
      automatic: true,
      runOnDeployedInstance: true,
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
    {
      id: 'deployment',
      name: 'Deployment',
      description: 'Deploy application to target environment',
      command: './target/release/app',
      type: 'deploy',
      automatic: true,
      runOnDeployedInstance: true,
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
      id: 'deployment',
      name: 'Deployment',
      description: 'Deploy application to target environment',
      command: 'docker run -d -p 8080:8080 $IMAGE_NAME',
      type: 'deploy',
      automatic: true,
      runOnDeployedInstance: true,
    },
  ],
};

interface ArtifactPattern {
  pattern: string;
  description: string;
}

interface ArtifactStorage {
  type: 'local' | 'aws_s3' | 'gcs';
  config: {
    bucketName?: string;
    region?: string;
    credentialsId?: string;
  };
}

interface ArtifactRetention {
  defaultDays: number;
  branchPatterns: {
    pattern: string;
    days: number;
  }[];
  maxStorageGB: number;
}

interface ArtifactConfig {
  enabled: boolean;
  patterns: ArtifactPattern[];
  storage: ArtifactStorage;
  retention: ArtifactRetention;
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
  githubToken?: string;  // GitHub Personal Access Token for webhook creation
  schedule: {
    cron: string;
    timezone: string;
  };
  steps: PipelineStep[];
  artifacts: ArtifactConfig;
  deployment: DeploymentConfig;
}

interface PipelineApiPayload {
  name: string;
  repository: string;
  description?: string;
  defaultBranch: string;
  steps: {
    name: string;
    command: string;
    timeout?: number;
    environment?: Record<string, string>;
    runLocation?: string;
  }[];
  triggers?: {
    branches?: string[];
    events?: ('push' | 'pull_request')[];
  };
  githubToken?: string;
  artifactsEnabled: boolean;
  artifactPatterns: string[];
  artifactRetentionDays: number;
  artifactStorageType: 'local' | 's3';
  artifactStorageConfig: {
    bucketName?: string;
    region?: string;
    credentialsId?: string;
  };
  deploymentEnabled: boolean;
  deploymentPlatform?: 'aws' | 'gcp' | 'azure' | 'kubernetes' | 'custom';
  deploymentConfig?: {
    // Common fields
    region?: string;
    service?: string;
    cluster?: string;
    namespace?: string;
    credentials?: string;
    customSettings?: Record<string, string>;
    // EC2 specific fields
    awsRegion?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    ec2InstanceId?: string;
    ec2DeployPath?: string;
    ec2SshKey?: string;
    ec2Username?: string;
    environmentVariables?: Record<string, string>;
    deploymentStrategy: DeploymentConfig['strategy'];
    blueGreenConfig?: BlueGreenConfig;
  };
}

interface StepFormData {
  name: string;
  description: string;
  command: string;
  type: 'source' | 'build' | 'test' | 'deploy' | 'custom';
}

const defaultArtifactPatterns: Record<string, ArtifactPattern[]> = {
  nodejs: [
    { pattern: 'dist/**', description: 'Distribution files' },
    { pattern: 'build/**', description: 'Build output' }
  ],
  java: [
    { pattern: 'target/*.jar', description: 'JAR files' },
    { pattern: 'target/*.war', description: 'WAR files' }
  ],
  python: [
    { pattern: 'dist/*.whl', description: 'Wheel packages' },
    { pattern: 'dist/*.tar.gz', description: 'Source distributions' }
  ],
  go: [
    { pattern: 'bin/*', description: 'Binary files' },
    { pattern: 'build/*', description: 'Build artifacts' }
  ]
};

// Add API URL and key configuration
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const API_KEY = import.meta.env.VITE_API_KEY;

// Add API URL normalization helper
const normalizeApiUrl = (baseUrl: string) => {
  // Remove trailing slash if present
  baseUrl = baseUrl.replace(/\/$/, '');
  // Remove /api suffix if present
  baseUrl = baseUrl.replace(/\/api$/, '');
  return baseUrl;
};

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
              {step.automatic && (
                <span className="inline-flex items-center px-2 py-1 mt-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  Automatic
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            {!step.automatic && (
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => onEdit(step)}
                type="button"
              >
                Edit
              </Button>
            )}
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
          {!step.automatic ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Terminal className="w-4 h-4 mr-1" />
              <code className="bg-muted px-2 py-1 rounded">{step.command}</code>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground italic">
              This step is handled automatically by the pipeline manager
            </div>
          )}
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
    artifacts: {
      enabled: true,
      patterns: [],
      storage: {
        type: 'local',
        config: {}
      },
      retention: {
        defaultDays: 30,
        branchPatterns: [
          {
            pattern: 'main',
            days: 90
          },
          {
            pattern: 'master',
            days: 90
          }
        ],
        maxStorageGB: 10
      }
    },
    deployment: {
      enabled: false,
      platform: 'aws',
      strategy: 'standard',
      config: {
        region: '',
        service: '',
        cluster: '',
        namespace: '',
        credentials: '',
        customSettings: {},
        blueGreenConfig: {
          productionPort: 8080,
          stagingPort: 8081,
          healthCheckPath: '/health',
          healthCheckTimeout: 30,
          rollbackOnFailure: false
        }
      }
    }
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
  const [newPattern, setNewPattern] = useState('');
  const [patternError, setPatternError] = useState('');
  const sshKeyFileInputRef = useRef<HTMLInputElement>(null);
  const [sshKeyFileName, setSshKeyFileName] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleInputChange = (field: keyof PipelineFormData, value: string) => {
    setFormData((prev) => {
      const newFormData = { ...prev, [field]: value };
      
      // If repository URL is being updated, sync it with REPO_URL environment variable
      if (field === 'repositoryUrl') {
        const existingEnvVars = newFormData.environmentVariables.filter(env => env.key !== 'REPO_URL');
        if (value) {
          existingEnvVars.push({ key: 'REPO_URL', value });
        }
        newFormData.environmentVariables = existingEnvVars;
      }
      
      return newFormData;
    });
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
    // Get the template steps
    const template = templateSteps[templateName];
    
    // Ensure the steps are in the correct order: source -> build -> deployment -> test
    const sourceStep = defaultSteps[0]; // The source step
    
    // Find steps by type
    const buildSteps = template.filter(step => step.type === 'build');
    const deploymentSteps = template.filter(step => step.type === 'deploy' && step.automatic);
    const testSteps = template.filter(step => step.type === 'test');
    const otherSteps = template.filter(step => 
      step.type !== 'build' && 
      step.type !== 'deploy' && 
      step.type !== 'test'
    );
    
    // Combine steps in the desired order
    const orderedSteps = [
      sourceStep,
      ...buildSteps,
      ...testSteps,
      ...deploymentSteps,
      ...otherSteps
    ];
    
    setFormData((prev) => ({
      ...prev,
      steps: orderedSteps,
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
      // Don't allow editing automatic steps
      if (editingStep.automatic) {
        setIsStepDialogOpen(false);
        return;
      }
      
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
      // Add new step with guaranteed ID
      const newStep: PipelineStep = {
        ...stepForm,
        id: crypto.randomUUID(),
        automatic: false // New steps are never automatic
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
    const {
      name,
      description,
      repositoryUrl,
      branch,
      steps,
      triggers,
      githubToken,
      artifacts,
      deployment
    } = formData;

    return {
      name,
      repository: repositoryUrl,
      description,
      defaultBranch: branch,
      steps: steps.map(step => ({
        name: step.name,
        command: step.command,
        runLocation: step.runOnDeployedInstance ? 'deployed_instance' : 'pipeline',
      })),
      triggers: {
        branches: [branch],
        events: [
          ...(triggers.onPush ? ['push'] : []),
          ...(triggers.onPullRequest ? ['pull_request'] : [])
        ] as ('push' | 'pull_request')[],
      },
      githubToken,
      artifactsEnabled: artifacts.enabled,
      artifactPatterns: artifacts.patterns.map(p => p.pattern),
      artifactRetentionDays: artifacts.retention.defaultDays,
      artifactStorageType: artifacts.storage.type === 'aws_s3' ? 's3' : 'local',
      artifactStorageConfig: {
        bucketName: artifacts.storage.config.bucketName,
        region: artifacts.storage.config.region,
        credentialsId: artifacts.storage.config.credentialsId,
      },
      deploymentEnabled: deployment.enabled,
      deploymentPlatform: deployment.platform,
      deploymentConfig: {
        ...deployment.config,
        deploymentStrategy: deployment.strategy,
        blueGreenConfig: deployment.strategy === 'blue-green' ? {
          productionPort: deployment.config.blueGreenConfig?.productionPort ?? 8080,
          stagingPort: deployment.config.blueGreenConfig?.stagingPort ?? 8081,
          healthCheckPath: deployment.config.blueGreenConfig?.healthCheckPath ?? '/health',
          healthCheckTimeout: deployment.config.blueGreenConfig?.healthCheckTimeout ?? 30,
          rollbackOnFailure: deployment.config.blueGreenConfig?.rollbackOnFailure ?? false
        } : undefined
      }
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const apiPayload = transformFormToApiPayload();
      console.log('Pipeline creation payload:', JSON.stringify(apiPayload, null, 2));
      await api.createPipeline(apiPayload);
      navigate('/');
    } catch (error) {
      console.error('Error creating pipeline:', error);
      
      if (error instanceof Error) {
        alert(`Failed to create pipeline: ${error.message}\nCheck the console for more details.`);
      } else {
        alert('Failed to create pipeline. Check the console for more details.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleArtifactChange = (field: keyof ArtifactConfig, value: any) => {
    setFormData(prev => ({
      ...prev,
      artifacts: {
        ...prev.artifacts,
        [field]: value
      }
    }));
  };

  const handleStorageConfigChange = (field: keyof ArtifactStorage['config'], value: string) => {
    setFormData(prev => ({
      ...prev,
      artifacts: {
        ...prev.artifacts,
        storage: {
          ...prev.artifacts.storage,
          config: {
            ...prev.artifacts.storage.config,
            [field]: value
          }
        }
      }
    }));
  };
  
  const handleDeploymentChange = (field: keyof DeploymentConfig, value: any) => {
    if (field === 'platform' && value === 'aws') {
      // When AWS is selected, initialize with default service if none is set
      setFormData(prev => ({
        ...prev,
        deployment: {
          ...prev.deployment,
          platform: value,
          config: {
            ...prev.deployment.config,
            service: prev.deployment.config.service || 'lambda' // Set default service
          }
        }
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        deployment: {
          ...prev.deployment,
          [field]: value,
          // Preserve config when changing platforms
          config: prev.deployment.config
        }
      }));
    }
  };

  const handleDeploymentConfigChange = (field: keyof DeploymentConfig['config'], value: any) => {
    setFormData(prev => ({
      ...prev,
      deployment: {
        ...prev.deployment,
        config: {
          ...prev.deployment.config,
          [field]: value
        }
      }
    }));
  };

  const handleBlueGreenConfigChange = (field: keyof BlueGreenConfig, value: BlueGreenConfig[keyof BlueGreenConfig]) => {
    setFormData(prev => ({
      ...prev,
      deployment: {
        ...prev.deployment,
        config: {
          ...prev.deployment.config,
          blueGreenConfig: {
            productionPort: prev.deployment.config.blueGreenConfig?.productionPort ?? 8080,
            stagingPort: prev.deployment.config.blueGreenConfig?.stagingPort ?? 8081,
            healthCheckPath: prev.deployment.config.blueGreenConfig?.healthCheckPath ?? '/health',
            healthCheckTimeout: prev.deployment.config.blueGreenConfig?.healthCheckTimeout ?? 30,
            rollbackOnFailure: prev.deployment.config.blueGreenConfig?.rollbackOnFailure ?? false,
            ...prev.deployment.config.blueGreenConfig,
            [field]: value
          }
        }
      }
    }));
  };

  const handleAddPattern = (pattern: string) => {
    if (!pattern.trim()) {
      setPatternError('Pattern cannot be empty');
      return;
    }
    
    try {
      // Basic pattern validation
      new RegExp(pattern.replace(/\*/g, '.*'));
      
      setFormData(prev => ({
        ...prev,
        artifacts: {
          ...prev.artifacts,
          patterns: [...prev.artifacts.patterns, { pattern: pattern.trim(), description: '' }]
        }
      }));
      setNewPattern('');
      setPatternError('');
    } catch (e) {
      setPatternError('Invalid pattern format');
    }
  };

  const handleRemovePattern = (index: number) => {
    setFormData(prev => ({
      ...prev,
      artifacts: {
        ...prev.artifacts,
        patterns: prev.artifacts.patterns.filter((_, i) => i !== index)
      }
    }));
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSshKeyFileName(file.name);
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      handleDeploymentConfigChange('ec2SshKey', content);
    };
    reader.readAsText(file);
  };

  const clearSshKeyFile = () => {
    handleDeploymentConfigChange('ec2SshKey', '');
    setSshKeyFileName(null);
    if (sshKeyFileInputRef.current) {
      sshKeyFileInputRef.current.value = '';
    }
  };

  return (
    <div className="container mx-auto py-6">
      <form onSubmit={handleSubmit} className="space-y-8">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold">Create Pipeline</h1>
          <div className="space-x-2">
            <Button variant="outline" type="button" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Creating...' : 'Create Pipeline'}
            </Button>
          </div>
        </div>

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
            <TabsTrigger value="artifacts" className="flex items-center gap-2">
              <Package size={16} />
              Artifacts
            </TabsTrigger>
            <TabsTrigger value="deployment" className="flex items-center gap-2">
              <Rocket size={16} />
              Deployment
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
              {formData.triggers.onPush && (
                <div className="ml-6 mt-2">
                  <label className="block text-sm font-medium mb-1">GitHub Personal Access Token</label>
                  <Input
                    type="password"
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    value={formData.githubToken || ''}
                    onChange={(e) => handleInputChange('githubToken', e.target.value)}
                  />
                  <p className="text-sm text-muted-foreground mt-1">
                    Required for webhook creation. Token must have 'repo' and 'admin:repo_hook' scopes.
                  </p>
                </div>
              )}
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

          <TabsContent value="artifacts" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Artifact Configuration</CardTitle>
                <CardDescription>Configure how build artifacts are stored and managed</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Enable Artifact Storage</Label>
                    <div className="text-sm text-muted-foreground">Store and manage build artifacts</div>
                  </div>
                  <Switch
                    checked={formData.artifacts.enabled}
                    onCheckedChange={(checked: boolean) => handleArtifactChange('enabled', checked)}
                  />
                </div>

                {formData.artifacts.enabled && (
                  <>
                    <Separator />
                    
                    <div className="space-y-4">
                      <div>
                        <Label>Storage Provider</Label>
                        <Select
                          value={formData.artifacts.storage.type}
                          onValueChange={(value: ArtifactStorage['type']) => 
                            handleArtifactChange('storage', { ...formData.artifacts.storage, type: value })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select storage provider" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="local">Local Storage</SelectItem>
                            <SelectItem value="aws_s3">AWS S3</SelectItem>
                            <SelectItem value="gcs">Google Cloud Storage</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {formData.artifacts.storage.type !== 'local' && (
                        <div className="space-y-4">
                          <div>
                            <Label>Bucket Name</Label>
                            <Input
                              value={formData.artifacts.storage.config.bucketName || ''}
                              onChange={(e) => handleStorageConfigChange('bucketName', e.target.value)}
                              placeholder="my-artifacts-bucket"
                            />
                          </div>
                          <div>
                            <Label>Region</Label>
                            <Input
                              value={formData.artifacts.storage.config.region || ''}
                              onChange={(e) => handleStorageConfigChange('region', e.target.value)}
                              placeholder="us-east-1"
                            />
                          </div>
                          <div>
                            <Label>Credentials ID</Label>
                            <Input
                              value={formData.artifacts.storage.config.credentialsId || ''}
                              onChange={(e) => handleStorageConfigChange('credentialsId', e.target.value)}
                              placeholder="my-cloud-credentials"
                            />
                          </div>
                        </div>
                      )}

                      <Separator />

                      <div className="space-y-4">
                        <Label>Artifact Patterns</Label>
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <Input
                              value={newPattern}
                              onChange={(e) => {
                                setNewPattern(e.target.value);
                                setPatternError('');
                              }}
                              placeholder="Enter pattern (e.g. dist/**, build/*.jar)"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  handleAddPattern(newPattern);
                                }
                              }}
                            />
                            <Button
                              type="button"
                              onClick={() => handleAddPattern(newPattern)}
                            >
                              Add
                            </Button>
                          </div>
                          {patternError && (
                            <p className="text-sm text-destructive">{patternError}</p>
                          )}
                          <p className="text-sm text-muted-foreground">Press Enter or click Add to add a pattern</p>
                        </div>

                        <div className="space-y-2">
                          <Label>Current Patterns</Label>
                          {formData.artifacts.patterns.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No patterns configured</p>
                          ) : (
                            <div className="space-y-2">
                              {formData.artifacts.patterns.map((pattern, index) => (
                                <div key={index} className="flex items-center gap-2 bg-muted p-2 rounded">
                                  <code className="flex-1 text-sm">{pattern.pattern}</code>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleRemovePattern(index)}
                                  >
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      <Separator />

                      <div className="space-y-4">
                        <Label>Retention Settings</Label>
                        <div>
                          <Label>Default Retention Period (days)</Label>
                          <Input
                            type="number"
                            value={formData.artifacts.retention.defaultDays}
                            onChange={(e) => handleArtifactChange('retention', {
                              ...formData.artifacts.retention,
                              defaultDays: parseInt(e.target.value) || 0
                            })}
                            min="1"
                          />
                        </div>
                        <div>
                          <Label>Maximum Storage (GB)</Label>
                          <Input
                            type="number"
                            value={formData.artifacts.retention.maxStorageGB}
                            onChange={(e) => handleArtifactChange('retention', {
                              ...formData.artifacts.retention,
                              maxStorageGB: parseInt(e.target.value) || 0
                            })}
                            min="1"
                          />
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="deployment" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Deployment Configuration</CardTitle>
                <CardDescription>Configure how your application is deployed</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Enable Deployment</Label>
                    <div className="text-sm text-muted-foreground">Configure deployment options for this pipeline</div>
                  </div>
                  <Switch
                    checked={formData.deployment.enabled}
                    onCheckedChange={(checked: boolean) => handleDeploymentChange('enabled', checked)}
                  />
                </div>

                {formData.deployment.enabled && (
                  <>
                    <Separator />
                    
                    <div className="space-y-4">
                      <div>
                        <Label>Deployment Strategy</Label>
                        <Select
                          value={formData.deployment.strategy}
                          onValueChange={(value: DeploymentConfig['strategy']) => 
                            handleDeploymentChange('strategy', value)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select deployment strategy" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="standard">
                              Standard Deployment
                              <p className="text-sm text-muted-foreground">
                                Traditional deployment with direct updates to the production environment
                              </p>
                            </SelectItem>
                            <SelectItem value="blue-green">
                              Blue/Green Deployment
                              <p className="text-sm text-muted-foreground">
                                Zero-downtime deployment using two identical environments for safer releases
                              </p>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {formData.deployment.strategy === 'blue-green' && (
                        <div className="space-y-4 border rounded-lg p-4">
                          <h3 className="text-lg font-medium">Blue/Green Configuration</h3>
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <Label>Production Port</Label>
                              <Input
                                type="number"
                                value={formData.deployment.config.blueGreenConfig?.productionPort || 8080}
                                onChange={(e) => handleBlueGreenConfigChange('productionPort', parseInt(e.target.value))}
                                placeholder="8080"
                              />
                            </div>
                            <div>
                              <Label>Staging Port</Label>
                              <Input
                                type="number"
                                value={formData.deployment.config.blueGreenConfig?.stagingPort || 8081}
                                onChange={(e) => handleBlueGreenConfigChange('stagingPort', parseInt(e.target.value))}
                                placeholder="8081"
                              />
                            </div>
                          </div>
                          <div>
                            <Label>Health Check Path</Label>
                            <Input
                              value={formData.deployment.config.blueGreenConfig?.healthCheckPath || '/health'}
                              onChange={(e) => handleBlueGreenConfigChange('healthCheckPath', e.target.value)}
                              placeholder="/health"
                            />
                            <p className="text-sm text-muted-foreground mt-1">
                              Endpoint path to verify application health before switching traffic
                            </p>
                          </div>
                          <div>
                            <Label>Health Check Timeout (seconds)</Label>
                            <Input
                              type="number"
                              value={formData.deployment.config.blueGreenConfig?.healthCheckTimeout || 30}
                              onChange={(e) => handleBlueGreenConfigChange('healthCheckTimeout', parseInt(e.target.value))}
                              placeholder="30"
                            />
                          </div>
                          <div className="flex items-center space-x-2">
                            <Switch
                              id="rollback"
                              checked={formData.deployment.config.blueGreenConfig?.rollbackOnFailure || false}
                              onCheckedChange={(checked) => handleBlueGreenConfigChange('rollbackOnFailure', checked)}
                            />
                            <Label htmlFor="rollback">Automatic Rollback on Failure</Label>
                          </div>
                        </div>
                      )}

                      <Separator />

                      <div>
                        <Label>Deployment Platform</Label>
                        <Select
                          value={formData.deployment.platform}
                          onValueChange={(value: DeploymentConfig['platform']) => 
                            handleDeploymentChange('platform', value)}
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

                      <Separator />

                      {formData.deployment.platform === 'aws' && (
                        <div className="space-y-4">
                          <div>
                            <Label>AWS Region</Label>
                            <Input
                              value={formData.deployment.config.region || ''}
                              onChange={(e) => handleDeploymentConfigChange('region', e.target.value)}
                              placeholder="us-east-1"
                            />
                          </div>
                          <div>
                            <Label>AWS Service</Label>
                            <Select 
                              value={formData.deployment.config.service || 'lambda'}
                              onValueChange={(value) => handleDeploymentConfigChange('service', value)}
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

                          {formData.deployment.config.service === 'ec2' && (
                            <>
                              <div>
                                <Label>AWS Access Key ID</Label>
                                <Input
                                  type="password"
                                  value={formData.deployment.config.awsAccessKeyId || ''}
                                  onChange={(e) => handleDeploymentConfigChange('awsAccessKeyId', e.target.value)}
                                  placeholder="AWS Access Key ID"
                                />
                              </div>
                              <div>
                                <Label>AWS Secret Access Key</Label>
                                <Input
                                  type="password"
                                  value={formData.deployment.config.awsSecretAccessKey || ''}
                                  onChange={(e) => handleDeploymentConfigChange('awsSecretAccessKey', e.target.value)}
                                  placeholder="AWS Secret Access Key"
                                />
                              </div>
                              <div>
                                <Label>EC2 Instance ID</Label>
                                <Input
                                  value={formData.deployment.config.ec2InstanceId || ''}
                                  onChange={(e) => handleDeploymentConfigChange('ec2InstanceId', e.target.value)}
                                  placeholder="i-1234567890abcdef0"
                                />
                              </div>
                              <div>
                                <Label>EC2 Deploy Path</Label>
                                <Input
                                  value={formData.deployment.config.ec2DeployPath || ''}
                                  onChange={(e) => handleDeploymentConfigChange('ec2DeployPath', e.target.value)}
                                  placeholder="/home/ec2-user/app"
                                />
                                <p className="text-sm text-muted-foreground mt-1">
                                  Path where the application will be deployed on the EC2 instance
                                </p>
                              </div>
                              <div>
                                <Label>EC2 SSH Key</Label>
                                <div className="space-y-2">
                                  <div className="flex flex-col gap-2">
                                    <div className="flex items-center gap-2">
                                      <Button 
                                        type="button" 
                                        variant="outline"
                                        onClick={() => sshKeyFileInputRef.current?.click()}
                                      >
                                        Upload .pem File
                                      </Button>
                                      <input
                                        type="file"
                                        ref={sshKeyFileInputRef}
                                        className="hidden"
                                        accept=".pem"
                                        onChange={handleFileUpload}
                                      />
                                      {sshKeyFileName ? (
                                        <div className="flex items-center gap-2">
                                          <span className="text-sm text-green-600">
                                            {sshKeyFileName}
                                          </span>
                                          <Button 
                                            type="button" 
                                            variant="ghost" 
                                            size="sm"
                                            onClick={clearSshKeyFile}
                                          >
                                            <Trash2 className="h-4 w-4" />
                                          </Button>
                                        </div>
                                      ) : null}
                                    </div>
                                    <Textarea
                                      value={formData.deployment.config.ec2SshKey || ''}
                                      onChange={(e) => handleDeploymentConfigChange('ec2SshKey', e.target.value)}
                                      placeholder="-----BEGIN RSA PRIVATE KEY-----"
                                      rows={3}
                                    />
                                  </div>
                                  <p className="text-sm text-muted-foreground">
                                    Upload your .pem file or paste the private SSH key for connecting to the EC2 instance
                                  </p>
                                </div>
                              </div>
                              <div>
                                <Label>EC2 Username</Label>
                                <Input
                                  value={formData.deployment.config.ec2Username || ''}
                                  onChange={(e) => handleDeploymentConfigChange('ec2Username', e.target.value)}
                                  placeholder="ec2-user"
                                />
                                <p className="text-sm text-muted-foreground mt-1">
                                  Default username for the EC2 instance (e.g., ec2-user, ubuntu)
                                </p>
                              </div>
                            </>
                          )}

                          <div>
                            <Label>Credentials ID</Label>
                            <Input
                              value={formData.deployment.config.credentials || ''}
                              onChange={(e) => handleDeploymentConfigChange('credentials', e.target.value)}
                              placeholder="aws-credentials"
                            />
                          </div>
                        </div>
                      )}

                      {formData.deployment.platform === 'gcp' && (
                        <div className="space-y-4">
                          <div>
                            <Label>GCP Region</Label>
                            <Input
                              value={formData.deployment.config.region || ''}
                              onChange={(e) => handleDeploymentConfigChange('region', e.target.value)}
                              placeholder="us-central1"
                            />
                          </div>
                          <div>
                            <Label>GCP Service</Label>
                            <Select defaultValue="cloudfunctions">
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
                          <div>
                            <Label>Credentials ID</Label>
                            <Input
                              value={formData.deployment.config.credentials || ''}
                              onChange={(e) => handleDeploymentConfigChange('credentials', e.target.value)}
                              placeholder="gcp-credentials"
                            />
                          </div>
                        </div>
                      )}

                      {formData.deployment.platform === 'azure' && (
                        <div className="space-y-4">
                          <div>
                            <Label>Azure Region</Label>
                            <Input
                              value={formData.deployment.config.region || ''}
                              onChange={(e) => handleDeploymentConfigChange('region', e.target.value)}
                              placeholder="eastus"
                            />
                          </div>
                          <div>
                            <Label>Azure Service</Label>
                            <Select defaultValue="functions">
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
                          <div>
                            <Label>Credentials ID</Label>
                            <Input
                              value={formData.deployment.config.credentials || ''}
                              onChange={(e) => handleDeploymentConfigChange('credentials', e.target.value)}
                              placeholder="azure-credentials"
                            />
                          </div>
                        </div>
                      )}

                      {formData.deployment.platform === 'kubernetes' && (
                        <div className="space-y-4">
                          <div>
                            <Label>Kubernetes Cluster</Label>
                            <Input
                              value={formData.deployment.config.cluster || ''}
                              onChange={(e) => handleDeploymentConfigChange('cluster', e.target.value)}
                              placeholder="my-cluster"
                            />
                          </div>
                          <div>
                            <Label>Namespace</Label>
                            <Input
                              value={formData.deployment.config.namespace || ''}
                              onChange={(e) => handleDeploymentConfigChange('namespace', e.target.value)}
                              placeholder="default"
                            />
                          </div>
                          <div>
                            <Label>Credentials ID</Label>
                            <Input
                              value={formData.deployment.config.credentials || ''}
                              onChange={(e) => handleDeploymentConfigChange('credentials', e.target.value)}
                              placeholder="kubeconfig"
                            />
                          </div>
                        </div>
                      )}

                      {formData.deployment.platform === 'custom' && (
                        <div className="space-y-4">
                          <div>
                            <Label>Custom Deployment Configuration</Label>
                            <p className="text-sm text-muted-foreground mb-2">
                              Define your custom deployment settings. These will be available as environment variables in your deployment step.
                            </p>
                            <div className="space-y-2">
                              <div className="flex gap-2">
                                <Input placeholder="Key" />
                                <Input placeholder="Value" />
                                <Button type="button">Add</Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
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
      </form>
    </div>
  );
};

export default PipelineCreationForm; 