import { Request, Response } from 'express';
import { EngineService } from '../services/engine.service';
import { NotFoundError } from '../utils/errors';
import { BuildStatus } from '../models/types';

export class BuildController {
  constructor(private engineService: EngineService) {}

  async listBuilds(req: Request, res: Response) {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const pipelineId = req.query.pipelineId as string;
      
      const builds = await this.engineService.listBuilds({
        page,
        limit,
        pipelineId,
        filter: req.query.filter as string,
        sort: req.query.sort as string
      });
      
      res.json({
        data: builds.items,
        pagination: {
          total: builds.total,
          page: builds.page,
          limit: builds.limit
        }
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to list builds' });
    }
  }

  async getBuild(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const build = await this.engineService.getBuild(id);
      
      if (!build) {
        throw new NotFoundError('Build not found');
      }

      res.json(build);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to get build' });
      }
    }
  }

  async cancelBuild(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const build = await this.engineService.getBuild(id);
      
      if (!build) {
        throw new NotFoundError('Build not found');
      }

      if (build.status !== BuildStatus.Running) {
        return res.status(400).json({ error: 'Build is not running' });
      }

      await this.engineService.cancelBuild(id);
      res.status(204).send();
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to cancel build' });
      }
    }
  }

  async getBuildLogs(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const build = await this.engineService.getBuild(id);
      
      if (!build) {
        throw new NotFoundError('Build not found');
      }

      const logs = await this.engineService.getBuildLogs(id);
      res.json(logs);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to get build logs' });
      }
    }
  }

  async getBuildArtifacts(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const build = await this.engineService.getBuild(id);
      
      if (!build) {
        throw new NotFoundError('Build not found');
      }

      const artifacts = await this.engineService.getBuildArtifacts(id);
      res.json(artifacts);
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else {
        res.status(500).json({ error: 'Failed to get build artifacts' });
      }
    }
  }
}
