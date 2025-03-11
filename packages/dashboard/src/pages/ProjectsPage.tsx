import React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import ProjectsList from '@/components/projects/ProjectsList';

const ProjectsPage: React.FC = () => {
  return (
    <div className="container py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Link
          to="/projects/new"
          className="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700"
        >
          New Project
        </Link>
      </div>
      <ProjectsList />
    </div>
  );
};

export default ProjectsPage; 