import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type DeployedApp } from '@/types/api';
import { useApi } from '@/lib/hooks/useApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { Trash2, Globe } from 'lucide-react';
import DomainManagement from '@/components/DomainManagement';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle
} from '@/components/ui/dialog';

export default function DeployedApps() {
  const [apps, setApps] = useState<DeployedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selectedApp, setSelectedApp] = useState<DeployedApp | null>(null);
  const [isDomainDialogOpen, setIsDomainDialogOpen] = useState(false);
  const api = useApi();
  const { toast } = useToast();

  const fetchApps = async () => {
    try {
      const response = await api.listDeployedApps();
      setApps(response.data);
    } catch (error) {
      console.error('Failed to fetch deployed apps:', error);
      toast({
        title: 'Error',
        description: 'Failed to fetch deployed applications',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApps();
  }, [api]);

  const handleDelete = async (id: string) => {
    try {
      setDeleting(id);
      await api.deleteDeployedApp(id);
      toast({
        title: 'Success',
        description: 'Deployment deleted successfully'
      });
      await fetchApps();
    } catch (error: any) {
      console.error('Failed to delete deployment:', error);
      toast({
        title: 'Error',
        description: error.response?.data?.message || 'Failed to delete deployment. Please check AWS credentials.',
        variant: 'destructive'
      });
    } finally {
      setDeleting(null);
    }
  };

  const handleOpenDomainDialog = (app: DeployedApp) => {
    setSelectedApp(app);
    setIsDomainDialogOpen(true);
  };

  const getStatusBadge = (status: DeployedApp['status']) => {
    const variants = {
      running: 'bg-green-100 text-green-800',
      stopped: 'bg-gray-100 text-gray-800',
      failed: 'bg-red-100 text-red-800'
    };

    return (
      <Badge className={variants[status]}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Deployed Applications</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-4">Loading...</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Last Deployed</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No deployed applications found
                    </TableCell>
                  </TableRow>
                ) : (
                  apps.map((app) => (
                    <TableRow key={app.id}>
                      <TableCell>{app.name}</TableCell>
                      <TableCell>
                        <a 
                          href={app.url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          {app.url}
                        </a>
                      </TableCell>
                      <TableCell>{getStatusBadge(app.status)}</TableCell>
                      <TableCell>{app.environment}</TableCell>
                      <TableCell>{new Date(app.lastDeployed).toLocaleString()}</TableCell>
                      <TableCell className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenDomainDialog(app)}
                          title="Manage Domains"
                        >
                          <Globe className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => handleDelete(app.id)}
                          disabled={deleting === app.id}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={isDomainDialogOpen} onOpenChange={setIsDomainDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Domain Management - {selectedApp?.name}</DialogTitle>
          </DialogHeader>
          
          {selectedApp && (
            <DomainManagement
              deployedAppId={selectedApp.id}
              appUrl={selectedApp.url}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
} 