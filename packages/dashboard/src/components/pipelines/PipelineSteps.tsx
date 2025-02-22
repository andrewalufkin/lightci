import React, { useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Terminal, CheckCircle2, XCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

interface Step {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  duration?: string;
  logs?: string[];
  error?: string;
}

interface PipelineStepsProps {
  steps: Step[];
  expanded?: boolean;
}

const getStatusColor = (status: Step['status']) => {
  switch (status) {
    case 'running':
      return 'border-blue-500 bg-blue-50';
    case 'completed':
      return 'border-green-500 bg-green-50';
    case 'failed':
      return 'border-red-500 bg-red-50';
    default:
      return 'border-gray-200 bg-gray-50';
  }
};

const getStatusIcon = (status: Step['status']) => {
  switch (status) {
    case 'running':
      return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />;
    case 'completed':
      return <CheckCircle2 className="w-5 h-5 text-green-500" />;
    case 'failed':
      return <XCircle className="w-5 h-5 text-red-500" />;
    default:
      return <Terminal className="w-5 h-5 text-gray-400" />;
  }
};

const getStatusBadge = (status: Step['status']) => {
  switch (status) {
    case 'running':
      return <Badge className="bg-blue-500">Running</Badge>;
    case 'completed':
      return <Badge className="bg-green-500">Completed</Badge>;
    case 'failed':
      return <Badge className="bg-red-500">Failed</Badge>;
    default:
      return null;
  }
};

export const PipelineSteps: React.FC<PipelineStepsProps> = ({ steps, expanded = false }) => {
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  console.log('[PipelineSteps] Rendering steps:', steps);
  
  const toggleErrorExpanded = (stepName: string) => {
    setExpandedErrors(prev => {
      const newSet = new Set(prev);
      if (newSet.has(stepName)) {
        newSet.delete(stepName);
      } else {
        newSet.add(stepName);
      }
      return newSet;
    });
  };

  return (
    <div className="space-y-4">
      {steps.map((step, index) => {
        console.log(`[PipelineSteps] Rendering step ${index}:`, {
          name: step.name,
          status: step.status,
          duration: step.duration,
          error: step.error
        });
        
        const isErrorExpanded = expandedErrors.has(step.name);
        
        return (
          <div
            key={`${step.name}-${index}`}
            className={cn(
              'border-2 rounded-lg p-4 transition-all duration-300 ease-in-out',
              getStatusColor(step.status),
              expanded && step.status === 'running' ? 'scale-105' : 'scale-100'
            )}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center space-x-3">
                {getStatusIcon(step.status)}
                <h3 className="font-medium">{step.name}</h3>
              </div>
              <div className="flex items-center space-x-3">
                {step.duration && (
                  <span className="text-sm text-gray-500">{step.duration}</span>
                )}
                {getStatusBadge(step.status) && getStatusBadge(step.status)}
              </div>
            </div>
            
            {expanded && step.status === 'running' && step.logs && (
              <div className="mt-4 bg-black rounded-md p-4 overflow-hidden">
                <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">
                  {step.logs.join('\n')}
                </pre>
              </div>
            )}

            {step.status === 'failed' && step.error && (
              <div className="mt-4">
                <div 
                  className="flex items-center space-x-2 text-red-600 cursor-pointer"
                  onClick={() => toggleErrorExpanded(step.name)}
                >
                  {isErrorExpanded ? (
                    <ChevronUp className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                  <span className="text-sm font-medium">
                    {isErrorExpanded ? 'Hide Error Details' : 'Show Error Details'}
                  </span>
                </div>
                <div className={cn(
                  'mt-2 transition-all duration-300',
                  isErrorExpanded ? 'block' : 'hidden'
                )}>
                  <div className="bg-red-50 border border-red-200 rounded-md p-4">
                    <pre className="text-sm text-red-700 font-mono whitespace-pre-wrap">
                      {step.error}
                    </pre>
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PipelineSteps; 