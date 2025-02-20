import { Request, Response } from 'express';
import { EngineService } from '../services/engine.service';
import { ValidationError } from '../utils/errors';

export class WebhookController {
  constructor(private engineService: EngineService) {}

  async handleGitHubWebhook(req: Request, res: Response) {
    try {
      const event = req.header('X-GitHub-Event');
      const signature = req.header('X-Hub-Signature-256');
      const delivery = req.header('X-GitHub-Delivery');

      if (!event || !signature || !delivery) {
        throw new ValidationError('Missing required GitHub webhook headers');
      }

      // Only handle push and pull_request events for now
      if (event !== 'push' && event !== 'pull_request') {
        return res.status(200).json({ message: 'Event type not supported' });
      }

      const payload = req.body;
      let branch: string;
      let commit: string;

      if (event === 'push') {
        if (!payload.ref || !payload.after) {
          throw new ValidationError('Missing required push event fields');
        }
        branch = payload.ref.replace('refs/heads/', '');
        commit = payload.after;
      } else {
        // pull_request event
        if (!payload.pull_request?.head?.ref || !payload.pull_request?.head?.sha) {
          throw new ValidationError('Missing required pull request event fields');
        }
        branch = payload.pull_request.head.ref;
        commit = payload.pull_request.head.sha;
      }

      if (!payload.repository?.html_url) {
        throw new ValidationError('Missing repository URL');
      }

      // Find pipeline by repository URL
      const pipelineResult = await this.engineService.listPipelines({
        page: 1,
        limit: 1,
        filter: payload.repository.html_url
      });

      if (pipelineResult.total === 0) {
        return res.status(404).json({ error: 'No pipeline found for this repository' });
      }

      const pipeline = pipelineResult.items[0];

      // Trigger build
      await this.engineService.triggerBuild(pipeline.id, {
        branch,
        commit
      });

      res.status(200).json({ message: 'Build triggered successfully' });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Failed to process webhook' });
      }
    }
  }

  async handleGitLabWebhook(req: Request, res: Response) {
    try {
      const event = req.header('X-Gitlab-Event');
      const token = req.header('X-Gitlab-Token');

      if (!event || !token) {
        throw new ValidationError('Missing required GitLab webhook headers');
      }

      // Only handle push and merge_request events for now
      if (event !== 'Push Hook' && event !== 'Merge Request Hook') {
        return res.status(200).json({ message: 'Event type not supported' });
      }

      const payload = req.body;
      let branch: string;
      let commit: string;

      if (event === 'Push Hook') {
        if (!payload.ref || !payload.after) {
          throw new ValidationError('Missing required push event fields');
        }
        branch = payload.ref.replace('refs/heads/', '');
        commit = payload.after;
      } else {
        // Merge Request Hook
        if (!payload.object_attributes?.source_branch || !payload.object_attributes?.last_commit?.id) {
          throw new ValidationError('Missing required merge request event fields');
        }
        branch = payload.object_attributes.source_branch;
        commit = payload.object_attributes.last_commit.id;
      }

      if (!payload.project?.web_url) {
        throw new ValidationError('Missing repository URL');
      }

      // Find pipeline by repository URL
      const pipelineResult = await this.engineService.listPipelines({
        page: 1,
        limit: 1,
        filter: payload.project.web_url
      });

      if (pipelineResult.total === 0) {
        return res.status(404).json({ error: 'No pipeline found for this repository' });
      }

      const pipeline = pipelineResult.items[0];

      // Trigger build
      await this.engineService.triggerBuild(pipeline.id, {
        branch,
        commit
      });

      res.status(200).json({ message: 'Build triggered successfully' });
    } catch (error) {
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message });
      } else {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Failed to process webhook' });
      }
    }
  }
}
