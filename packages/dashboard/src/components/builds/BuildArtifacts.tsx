import React, { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Download, Folder, File, AlertCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { formatBytes } from '@/lib/utils';
import { api } from '@/services/api';
import { toast } from 'sonner';

interface Artifact {
  id: string;
  name: string;
  path: string;
  size: number;
  contentType?: string;
  metadata?: Record<string, string>;
  createdAt: Date;
}

interface BuildArtifactsProps {
  buildId: string;
}

export function BuildArtifacts({ buildId }: BuildArtifactsProps) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchArtifacts();
  }, [buildId]);

  const fetchArtifacts = async () => {
    try {
      setLoading(true);
      const data = await api.listBuildArtifacts(buildId);
      setArtifacts(data);
    } catch (err) {
      console.error('Error fetching artifacts:', err);
      setError(err instanceof Error ? err.message : 'Failed to load artifacts');
      toast.error('Failed to load artifacts');
    } finally {
      setLoading(false);
    }
  };

  const downloadArtifact = async (artifactId: string, name: string) => {
    try {
      const blob = await api.downloadArtifact(artifactId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success('Artifact downloaded successfully');
    } catch (err) {
      console.error('Error downloading artifact:', err);
      toast.error('Failed to download artifact');
    }
  };

  const getFileIcon = (contentType?: string) => {
    if (!contentType) return <File className="h-4 w-4" />;
    if (contentType.startsWith('application/zip') || contentType.includes('compressed')) {
      return <Folder className="h-4 w-4" />;
    }
    return <File className="h-4 w-4" />;
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Build Artifacts</CardTitle>
          <CardDescription>Loading artifacts...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Build Artifacts</CardTitle>
          <CardDescription className="text-red-500 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (artifacts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Build Artifacts</CardTitle>
          <CardDescription>No artifacts found for this build.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Build Artifacts</CardTitle>
        <CardDescription>
          {artifacts.length} artifact{artifacts.length !== 1 ? 's' : ''} available
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {artifacts.map((artifact) => (
              <TableRow key={artifact.id}>
                <TableCell className="flex items-center gap-2">
                  {getFileIcon(artifact.contentType)}
                  {artifact.name}
                </TableCell>
                <TableCell>{formatBytes(artifact.size)}</TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {artifact.contentType || 'Unknown'}
                  </Badge>
                </TableCell>
                <TableCell>
                  {formatDistanceToNow(new Date(artifact.createdAt), { addSuffix: true })}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => downloadArtifact(artifact.id, artifact.name)}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
} 