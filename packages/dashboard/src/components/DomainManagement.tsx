import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, CheckCircle, Trash2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogFooter, 
  DialogHeader, 
  DialogTitle, 
  DialogTrigger 
} from '@/components/ui/dialog';

interface Domain {
  id: string;
  domain: string;
  verified: boolean;
  status: string;
  verifyToken: string;
  deployedAppId: string;
  createdAt: string;
  updatedAt: string;
}

interface DomainManagementProps {
  deployedAppId: string;
  appUrl: string;
}

export default function DomainManagement({ deployedAppId, appUrl }: DomainManagementProps) {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDomain, setNewDomain] = useState('');
  const [addingDomain, setAddingDomain] = useState(false);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const { toast } = useToast();

  const fetchDomains = async () => {
    try {
      setLoading(true);
      const response = await api.listDomains(deployedAppId);
      setDomains(response.domains);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to load domains",
        description: "There was an error loading your domains."
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (deployedAppId) {
      fetchDomains();
    }
  }, [deployedAppId]);

  const handleAddDomain = async () => {
    if (!newDomain) return;
    
    try {
      setAddingDomain(true);
      const domain = await api.addDomain(newDomain, deployedAppId);
      setDomains([...domains, domain]);
      setNewDomain('');
      setIsAddDialogOpen(false);
      toast({
        title: "Domain added",
        description: "You need to verify domain ownership to complete setup."
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to add domain",
        description: error instanceof Error ? error.message : "There was an error adding your domain."
      });
    } finally {
      setAddingDomain(false);
    }
  };

  const handleVerifyDomain = async (id: string) => {
    try {
      const result = await api.verifyDomain(id);
      
      if (result.success) {
        fetchDomains(); // Refresh the list
        toast({
          title: "Domain verified",
          description: "Your domain was successfully verified."
        });
      } else {
        toast({
          variant: "destructive",
          title: "Verification failed",
          description: result.message || "Please check that your DNS records are properly configured."
        });
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Verification error",
        description: "There was an error verifying your domain."
      });
    }
  };

  const handleDeleteDomain = async (id: string) => {
    try {
      await api.deleteDomain(id);
      setDomains(domains.filter(domain => domain.id !== id));
      toast({
        title: "Domain removed",
        description: "The domain was successfully removed."
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to remove domain",
        description: "There was an error removing the domain."
      });
    }
  };

  const getStatusBadge = (status: string, verified: boolean) => {
    if (status === 'active' && verified) {
      return <Badge className="bg-green-500">Active</Badge>;
    } else if (status === 'pending') {
      return <Badge className="bg-yellow-500">Pending</Badge>;
    } else {
      return <Badge className="bg-red-500">Failed</Badge>;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Custom Domains</h2>
        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
          <DialogTrigger asChild>
            <Button>Add Domain</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Custom Domain</DialogTitle>
              <DialogDescription>
                Enter the domain you want to use for your application.
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                placeholder="example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button 
                onClick={handleAddDomain} 
                disabled={addingDomain || !newDomain}
              >
                {addingDomain ? "Adding..." : "Add Domain"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div>
        <p className="text-sm text-gray-500 mb-2">
          Current app URL: <span className="font-mono">{appUrl}</span>
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <RefreshCw className="animate-spin" />
        </div>
      ) : domains.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-6">
              <p className="text-gray-500">No custom domains added yet</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {domains.map((domain) => (
            <Card key={domain.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="font-mono">{domain.domain}</CardTitle>
                  {getStatusBadge(domain.status, domain.verified)}
                </div>
              </CardHeader>
              <CardContent>
                {!domain.verified ? (
                  <div className="space-y-4">
                    <div className="bg-amber-50 p-4 rounded-md border border-amber-200">
                      <div className="flex gap-2">
                        <AlertCircle className="text-amber-500" />
                        <div>
                          <h4 className="font-semibold">Domain needs verification</h4>
                          <p className="text-sm text-gray-600">
                            Add the following TXT record to your DNS configuration:
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 p-2 bg-gray-100 rounded font-mono text-sm break-all">
                        {domain.verifyToken}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle />
                    <span>Domain verified and active</span>
                  </div>
                )}
              </CardContent>
              <CardFooter className="flex justify-between">
                {!domain.verified && (
                  <Button 
                    variant="outline" 
                    onClick={() => handleVerifyDomain(domain.id)}
                  >
                    Verify Domain
                  </Button>
                )}
                <Button
                  variant="destructive"
                  size="icon"
                  onClick={() => handleDeleteDomain(domain.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
} 