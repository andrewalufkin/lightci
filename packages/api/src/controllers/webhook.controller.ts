import { Request, Response } from 'express';
import { EngineService } from '../services/engine.service';
import { ValidationError } from '../utils/errors';
import { GitHubService } from '../services/github.service';
import { PipelineRunnerService } from '../services/pipeline-runner.service';
import { WorkspaceService } from '../services/workspace.service';
import { db } from '../services/database.service';

export class WebhookController {
  private githubService: GitHubService;
  private pipelineRunnerService: PipelineRunnerService;

  constructor(private engineService: EngineService) {
    this.githubService = new GitHubService(process.env.API_BASE_URL || 'http://localhost:3000');
    this.pipelineRunnerService = new PipelineRunnerService(new WorkspaceService());
  }

  async handleGitHubWebhook(req: Request, res: Response) {
    try {
      console.log('[WebhookController] Received GitHub webhook request');
      const event = req.header('X-GitHub-Event');
      const signature = req.header('X-Hub-Signature-256');
      const delivery = req.header('X-GitHub-Delivery');

      console.log('[WebhookController] Webhook headers:', {
        event,
        signature: signature ? 'present' : 'missing',
        delivery
      });

      if (!event || !signature || !delivery) {
        console.log('[WebhookController] Missing required headers');
        throw new ValidationError('Missing required GitHub webhook headers');
      }

      // Verify webhook signature
      const rawBody = JSON.stringify(req.body);
      console.log('[WebhookController] Verifying webhook signature');
      if (!this.githubService.verifyWebhookSignature(rawBody, signature)) {
        console.log('[WebhookController] Invalid webhook signature');
        throw new ValidationError('Invalid webhook signature');
      }
      console.log('[WebhookController] Webhook signature verified successfully');

      // Only handle push and pull_request events for now
      if (event !== 'push' && event !== 'pull_request') {
        console.log('[WebhookController] Unsupported event type:', event);
        return res.status(200).json({ message: 'Event type not supported' });
      }

      const payload = req.body;
      console.log('[WebhookController] Webhook payload:', {
        event,
        repository: payload.repository?.html_url,
        ref: payload.ref,
        commit: payload.after
      });

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
      const pipelineResult = await db.listPipelines({
        page: 1,
        limit: 1,
        filter: payload.repository.html_url
      });

      if (pipelineResult.total === 0) {
        return res.status(404).json({ error: 'No pipeline found for this repository' });
      }

      const pipeline = pipelineResult.items[0];

      // Check if the event type is enabled in the pipeline triggers
      const triggers = typeof pipeline.triggers === 'string' ? JSON.parse(pipeline.triggers) : pipeline.triggers || {};
      console.log('[WebhookController] Pipeline triggers:', {
        pipelineId: pipeline.id,
        triggers,
        event,
        events: triggers.events || []
      });

      const events = triggers.events || [];
      if (!events.includes(event)) {
        console.log('[WebhookController] Event type not enabled for this pipeline');
        return res.status(200).json({ message: 'Event type not enabled for this pipeline' });
      }

      console.log('[WebhookController] Event type enabled, triggering pipeline run');
      // Run pipeline
      const runId = await this.pipelineRunnerService.runPipeline(pipeline.id, branch, commit);

      console.log('[WebhookController] Pipeline run triggered:', { runId });

      res.status(200).json({ 
        message: 'Pipeline run triggered successfully',
        runId
      });
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
      const pipelineResult = await db.listPipelines({
        page: 1,
        limit: 1,
        filter: payload.project.web_url
      });

      if (pipelineResult.total === 0) {
        return res.status(404).json({ error: 'No pipeline found for this repository' });
      }

      const pipeline = pipelineResult.items[0];

      // Run pipeline
      const runId = await this.pipelineRunnerService.runPipeline(pipeline.id, branch, commit);

      res.status(200).json({ message: 'Build triggered successfully', runId });
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
