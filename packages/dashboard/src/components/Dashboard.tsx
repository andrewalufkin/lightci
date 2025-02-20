import React, { useState, useEffect } from 'react';
import { Play, Pause, RefreshCw, Clock, AlertCircle, CheckCircle, Terminal } from 'lucide-react';
import { api, Pipeline as APIPipeline, Build as APIBuild } from '../services/api';
import { Link } from 'react-router-dom';

interface Step {
  name: string;
  status: 'running' | 'failed' | 'completed' | 'pending';
  duration?: string;
}

interface Pipeline extends Omit<APIPipeline, 'createdAt' | 'updatedAt'> {
  progress: number;
  duration: string;
  steps: Step[];
}

interface Build extends Omit<APIBuild, 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt'> {
  duration: number;
}

const DashboardV2 = () => {
  const [view, setView] = useState('active');
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPipelines();
  }, [view]);

  const fetchPipelines = async () => {
    try {
      setLoading(true);
      const response = await api.listPipelines(1, 10);
      
      // Transform API data to match our UI needs
      const transformedPipelines = response.data.map(pipeline => {
        const progress = calculateProgress(pipeline.status);
        const duration = calculateDuration(pipeline.createdAt, pipeline.updatedAt);
        const steps = generateSteps(pipeline.status);

        return {
          ...pipeline,
          progress,
          duration,
          steps
        };
      });

      setPipelines(transformedPipelines);
      setError(null);
    } catch (err) {
      setError('Failed to fetch pipelines');
      console.error('Error fetching pipelines:', err);
    } finally {
      setLoading(false);
    }
  };

  const calculateProgress = (status: string): number => {
    switch (status) {
      case 'completed':
        return 100;
      case 'failed':
        return 60;
      case 'running':
        return 75;
      default:
        return 0;
    }
  };

  const calculateDuration = (start: string, end: string): string => {
    const duration = new Date(end).getTime() - new Date(start).getTime();
    const minutes = Math.floor(duration / (1000 * 60));
    const seconds = Math.floor((duration % (1000 * 60)) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const generateSteps = (status: string): Step[] => {
    const steps: Step[] = [
      { name: 'Install Dependencies', status: 'completed', duration: '1:20' },
      { name: 'Run Tests', status: 'completed', duration: '2:15' },
      { name: 'Build Docker Image', status: status === 'running' ? 'running' : 'completed', duration: '0:57' },
      { name: 'Deploy to Staging', status: status === 'pending' ? 'pending' : 'completed' }
    ];

    if (status === 'failed') {
      steps[2].status = 'failed';
      steps[3].status = 'pending';
    }

    return steps;
  };

  const StatusBadge = ({ status }: { status: Pipeline['status'] }) => {
    const styles = {
      running: 'bg-blue-100 text-blue-800',
      failed: 'bg-red-100 text-red-800',
      completed: 'bg-green-100 text-green-800',
      pending: 'bg-gray-100 text-gray-800'
    };

    const icons = {
      running: Play,
      failed: AlertCircle,
      completed: CheckCircle,
      pending: Clock
    };

    const Icon = icons[status];
    
    return (
      <span className={`flex items-center px-3 py-1 rounded-full text-sm ${styles[status]}`}>
        <Icon className="w-4 h-4 mr-1" />
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </span>
    );
  };

  const getCurrentStep = (steps: Step[]) => {
    return steps.find(step => step.status === 'running') || 
           steps.find(step => step.status === 'pending') ||
           steps[steps.length - 1];
  };

  const handleRefresh = () => {
    fetchPipelines();
  };

  const handleCreatePipeline = async () => {
    try {
      await api.createPipeline({
        name: 'New Pipeline',
        repository: 'https://github.com/example/repo',
        steps: [
          { name: 'Install Dependencies', command: 'npm install' },
          { name: 'Run Tests', command: 'npm test' }
        ]
      });
      fetchPipelines();
    } catch (err) {
      setError('Failed to create pipeline');
      console.error('Error creating pipeline:', err);
    }
  };

  if (loading) {
    return <div className="flex justify-center items-center h-screen">Loading...</div>;
  }

  if (error) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-6">
              <Link to="/" className="text-xl font-bold text-blue-600 hover:text-blue-700">LightCI</Link>
              <h1 className="text-2xl font-bold text-gray-900">Pipelines</h1>
            </div>
            <div className="flex items-center space-x-4">
              <button 
                onClick={handleCreatePipeline}
                className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
              >
                New Pipeline
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex space-x-4 mb-6">
          {['active', 'all', 'failed'].map((type) => (
            <button
              key={type}
              onClick={() => setView(type)}
              className={`px-4 py-2 rounded-md ${
                view === type
                  ? 'bg-gray-200 text-gray-800'
                  : 'bg-white text-gray-600 hover:bg-gray-100'
              }`}
            >
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {pipelines.map((pipeline) => {
            const currentStep = getCurrentStep(pipeline.steps);
            
            return (
              <div key={pipeline.id} className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow">
                <div className="p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center space-x-4">
                      <h3 className="text-lg font-medium text-gray-900">{pipeline.name}</h3>
                      <StatusBadge status={pipeline.status} />
                    </div>
                    <div className="flex items-center space-x-2">
                      <button 
                        onClick={handleRefresh}
                        className="p-2 text-gray-400 hover:text-gray-600"
                      >
                        <RefreshCw className="w-5 h-5" />
                      </button>
                      <button className="p-2 text-gray-400 hover:text-gray-600">
                        <Pause className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                  
                  <div className="mb-4">
                    <div className="flex items-center space-x-2 text-sm text-gray-600">
                      <Terminal className="w-4 h-4" />
                      <span>Current Step: {currentStep.name}</span>
                      <StatusBadge status={currentStep.status} />
                      {currentStep.duration && (
                        <span className="text-gray-500">({currentStep.duration})</span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div 
                        className={`h-full rounded-full ${
                          pipeline.status === 'failed' ? 'bg-red-500' : 
                          pipeline.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${pipeline.progress}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-sm text-gray-500">
                      <span>{pipeline.steps.filter(s => s.status === 'completed').length} of {pipeline.steps.length} steps</span>
                      <div className="flex items-center">
                        <Clock className="w-4 h-4 mr-1" />
                        <span>{pipeline.duration}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
};

export default DashboardV2; 