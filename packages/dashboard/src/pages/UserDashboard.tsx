import React from 'react';
import { Helmet } from 'react-helmet';
import StorageUsage from '../components/user/StorageUsage';

const UserDashboard: React.FC = () => {
  return (
    <div className="container mx-auto py-6">
      <Helmet>
        <title>User Dashboard | LightCI</title>
      </Helmet>
      
      <div className="mb-6">
        <h1 className="text-3xl font-bold">User Dashboard</h1>
        <p className="text-muted-foreground">Manage your account and view usage statistics</p>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <StorageUsage />
        {/* Add more dashboard cards here */}
      </div>
    </div>
  );
};

export default UserDashboard; 