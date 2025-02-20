import React from 'react';
import PipelineCreationForm from '@/components/pipelines/PipelineCreationForm';

const CreatePipeline: React.FC = () => {
  return (
    <div className="container py-8">
      <PipelineCreationForm />
    </div>
  );
};

export default CreatePipeline; 