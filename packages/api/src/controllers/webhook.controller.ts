import { Request, Response } from 'express-serve-static-core';
import * as crypto from 'crypto';
import { PipelineService } from '../services/pipeline.service';
import { PipelineRunnerService } from '../services/pipeline-runner.service';

export class WebhookController {
  constructor(
    private pipelineService: PipelineService,
    private pipelineRunner: PipelineRunnerService
  ) {}

  /**
   * Verifies the GitHub webhook signature
   */
  private verifyGitHubSignature(signature: string, payload: any, secret: string): boolean {
    if (!signature) {
      return false;
    }

    // Get the signature from the header (remove 'sha256=' prefix if present)
    const signatureValue = signature.startsWith('sha256=') ? signature.substring(7) : signature;
    
    // Create expected signature
    const hmac = crypto.createHmac('sha256', secret);
    // Convert payload to string if it's not already
    const rawBody = typeof payload === 'string' ? payload : JSON.stringify(payload);
    hmac.update(rawBody);
    const expectedSignature = hmac.digest('hex');
    
    // Use a timing-safe comparison for the signatures
    try {
      // Convert both signatures to Buffers of the same length
      const signatureBuffer = Buffer.from(signatureValue, 'hex');
      const expectedBuffer = Buffer.from(expectedSignature, 'hex');
      
      // Return the result of the comparison
      return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
    } catch (error) {
      console.error('Error comparing signatures:', error);
      return false;
    }
  }

  /**
   * Checks if a branch should trigger a pipeline based on the configuration
   * This needs to be public to be accessible from tests
   */
  public shouldTriggerForBranch(branchName: string, triggers: any): boolean {
    console.log(`[WebhookController] Checking if branch ${branchName} should trigger pipeline with config:`, JSON.stringify(triggers));
    
    // If no branch filters are explicitly configured, default to allowing all branches
    if (!triggers || !triggers.branches || triggers.branches.length === 0) {
      console.log(`[WebhookController] No branch filters configured, allowing branch ${branchName}`);
      return true;
    }

    // Check if branch matches any of the configured patterns
    const shouldTrigger = triggers.branches.some((pattern: string) => {
      // Exact match
      if (pattern === branchName) {
        console.log(`[WebhookController] Branch ${branchName} exact match with pattern ${pattern}`);
        return true;
      }
      
      // Wildcard match for pattern ending with /*
      if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -2); // Remove the /*
        if (branchName.startsWith(prefix)) {
          console.log(`[WebhookController] Branch ${branchName} wildcard match with pattern ${pattern}`);
          return true;
        }
      }
      
      // Global wildcard
      if (pattern === '*') {
        console.log(`[WebhookController] Branch ${branchName} matches global wildcard`);
        return true;
      }
      
      return false;
    });
    
    console.log(`[WebhookController] Branch ${branchName} trigger result: ${shouldTrigger}`);
    return shouldTrigger;
  }

  /**
   * Handles GitHub webhook requests
   */
  public async handleGitHubWebhook(req: Request, res: Response) {
    try {
      const signature = req.headers['x-hub-signature-256'] as string;
      const event = req.headers['x-github-event'] as string;
      const deliveryId = req.headers['x-github-delivery'] as string;
      const payload = req.body;
      
      console.log(`[WebhookController] Received GitHub ${event} webhook`);
      
      // Get webhook secret from environment
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
      
      if (!webhookSecret) {
        return res.status(500).json({ error: 'Webhook secret not configured' });
      }
      
      // Verify signature
      if (!signature || !this.verifyGitHubSignature(signature, payload, webhookSecret)) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
      
      // Find matching pipeline based on repository
      let repoUrl = '';
      if (payload.repository) {
        repoUrl = payload.repository.clone_url || payload.repository.html_url;
      }
      
      if (!repoUrl) {
        return res.status(400).json({ error: 'Missing repository URL' });
      }
      
      // Find pipeline with matching repository
      const pipeline = await this.pipelineService.findPipelineByRepository(repoUrl);
      
      if (!pipeline) {
        return res.status(404).json({ error: 'No pipeline configured for this repository' });
      }
      
      // Process based on event type
      let result;
      if (event === 'push') {
        result = await this.handlePushEvent(payload, pipeline);
      } else if (event === 'pull_request' && ['opened', 'reopened', 'synchronize'].includes(payload.action)) {
        result = await this.handlePullRequestEvent(payload, pipeline);
      } else {
        // Unsupported event or pull_request action
        return res.status(200).json({
          message: `Event ${event} (${payload.action || ''}) is not configured to trigger pipeline`
        });
      }
      
      return res.status(result.status).json({
        message: result.message,
        pipelineRunId: result.pipelineRunId
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Missing') || error.message.includes('Invalid')) {
          return res.status(400).json({ error: error.message });
        } else {
          console.error('GitHub webhook error:', error);
          return res.status(500).json({ error: 'Failed to process webhook' });
        }
      }
      return res.status(500).json({ error: 'Unknown error' });
    }
  }

  /**
   * Handles GitHub push events
   */
  private async handlePushEvent(payload: any, pipeline: any) {
    // Extract branch from ref (refs/heads/main -> main)
    const ref = payload.ref || '';
    const branchName = ref.replace('refs/heads/', '');
    
    // Check if this branch should trigger a pipeline
    if (!this.shouldTriggerForBranch(branchName, pipeline.triggers)) {
      console.log(`[WebhookController] Branch ${branchName} is not configured to trigger pipeline`);
      return {
        status: 200,
        message: `Branch ${branchName} is not configured to trigger pipeline`
      };
    }
    
    // Extract commit SHA
    const commitSha = payload.after;
    if (!commitSha) {
      throw new Error('Missing commit SHA');
    }
    
    // Extract repository info
    const repoUrl = payload.repository?.clone_url || payload.repository?.html_url;
    if (!repoUrl) {
      throw new Error('Missing repository URL');
    }
    
    console.log(`[WebhookController] Creating pipeline run for branch=${branchName}, commit=${commitSha}`);
    
    // Create pipeline run
    const pipelineRun = await this.pipelineService.createPipelineRun({
      pipelineId: pipeline.id,
      branch: branchName,
      commit: commitSha,
      status: 'pending',
      triggeredBy: 'webhook',
      repository: repoUrl
    });
    
    // Start pipeline execution in background
    this.pipelineRunner.runPipeline(pipeline.id, branchName, commitSha).catch(error => {
      console.error(`Error running pipeline ${pipeline.id}:`, error);
    });
    
    return {
      status: 200,
      message: 'Build triggered successfully',
      pipelineRunId: pipelineRun.id
    };
  }

  /**
   * Handles GitHub pull request events
   */
  private async handlePullRequestEvent(payload: any, pipeline: any) {
    // Extract branch and commit information
    const sourceBranch = payload.pull_request?.head?.ref;
    const targetBranch = payload.pull_request?.base?.ref;
    const commitSha = payload.pull_request?.head?.sha;
    
    if (!sourceBranch || !targetBranch || !commitSha) {
      throw new Error('Missing branch or commit information');
    }
    
    // For pull requests, we check if the target branch is in the allowed list
    // This allows PRs from any branch as long as they target an allowed branch
    if (!this.shouldTriggerForBranch(targetBranch, pipeline.triggers)) {
      return {
        status: 200,
        message: `Target branch ${targetBranch} is not configured to trigger pipeline`
      };
    }
    
    // Extract repository info
    const repoUrl = payload.repository?.clone_url || payload.repository?.html_url;
    if (!repoUrl) {
      throw new Error('Missing repository URL');
    }
    
    // Create pipeline run
    const pipelineRun = await this.pipelineService.createPipelineRun({
      pipelineId: pipeline.id,
      branch: sourceBranch,
      commit: commitSha,
      status: 'pending',
      triggeredBy: 'webhook',
      repository: repoUrl,
      prNumber: payload.pull_request?.number
    });
    
    // Start pipeline execution in background
    this.pipelineRunner.runPipeline(pipeline.id, sourceBranch, commitSha).catch(error => {
      console.error(`Error running pipeline ${pipeline.id}:`, error);
    });
    
    return {
      status: 200,
      message: 'Build triggered successfully',
      pipelineRunId: pipelineRun.id
    };
  }

  /**
   * Handles GitLab webhook requests
   */
  public async handleGitLabWebhook(req: Request, res: Response) {
    try {
      const token = req.headers['x-gitlab-token'] as string;
      const event = req.headers['x-gitlab-event'] as string;
      const payload = req.body;
      
      console.log(`[WebhookController] Received GitLab ${event || payload.object_kind} webhook`);
      
      // Extract repository information
      let repoPath = '';
      
      if (payload.project?.path_with_namespace) {
        repoPath = payload.project.path_with_namespace;
      } else if (payload.repository?.name && payload.project_id) {
        // Fallback for older GitLab versions
        repoPath = `${payload.project_id}/${payload.repository.name}`;
      } else if (payload.repository?.url) {
        // Try to extract from repository URL
        const urlMatch = payload.repository.url.match(/gitlab\.com[\/:]([^\/]+\/[^\/]+)(?:\.git)?$/);
        if (urlMatch) {
          repoPath = urlMatch[1];
        }
      }
      
      if (!repoPath) {
        return res.status(400).json({ error: 'Missing repository information' });
      }
      
      // Convert GitLab repository path to URL format for matching
      const repoUrl = `https://gitlab.com/${repoPath}`;
      
      // Find pipeline with matching repository
      const pipeline = await this.pipelineService.findPipelineByRepository(repoUrl);
      
      if (!pipeline) {
        return res.status(404).json({ error: 'No pipeline configured for this repository' });
      }
      
      // Check webhook secret
      const webhookSecret = pipeline.webhookConfig?.secret || process.env.GITLAB_WEBHOOK_SECRET;
      
      if (!webhookSecret) {
        return res.status(500).json({ error: 'Webhook secret not configured' });
      }
      
      // Verify token
      if (!token || token !== webhookSecret) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      
      // Handle different event types
      if (event === 'Push Hook' || payload.object_kind === 'push') {
        // Handle push event
        const ref = payload.ref || '';
        const branchName = ref.replace('refs/heads/', '');
        const commitSha = payload.after || payload.checkout_sha;
        
        if (!commitSha) {
          return res.status(400).json({ error: 'Missing commit SHA' });
        }
        
        // Check branch triggers
        if (!this.shouldTriggerForBranch(branchName, pipeline.triggers)) {
          return res.status(200).json({
            message: `Branch ${branchName} is not configured to trigger pipeline`
          });
        }
        
        // Create pipeline run
        const pipelineRun = await this.pipelineService.createPipelineRun({
          pipelineId: pipeline.id,
          branch: branchName,
          commit: commitSha,
          status: 'pending',
          triggeredBy: 'webhook',
          repository: repoUrl
        });
        
        // Start pipeline execution in background
        this.pipelineRunner.runPipeline(pipeline.id, branchName, commitSha).catch(error => {
          console.error(`Error running pipeline ${pipeline.id}:`, error);
        });
        
        return res.status(200).json({
          message: 'Build triggered successfully',
          pipelineRunId: pipelineRun.id
        });
      } else if (event === 'Merge Request Hook' || payload.object_kind === 'merge_request') {
        // Handle merge request event
        const sourceBranch = payload.object_attributes?.source_branch;
        const targetBranch = payload.object_attributes?.target_branch;
        const commitSha = payload.object_attributes?.last_commit?.id || payload.object_attributes?.source_sha;
        
        if (!sourceBranch || !targetBranch || !commitSha) {
          return res.status(400).json({ error: 'Missing branch or commit information' });
        }
        
        // For merge requests, check if target branch is in allowed list
        if (!this.shouldTriggerForBranch(targetBranch, pipeline.triggers)) {
          return res.status(200).json({
            message: `Target branch ${targetBranch} is not configured to trigger pipeline`
          });
        }
        
        // Create pipeline run
        const pipelineRun = await this.pipelineService.createPipelineRun({
          pipelineId: pipeline.id,
          branch: sourceBranch,
          commit: commitSha,
          status: 'pending',
          triggeredBy: 'webhook',
          repository: repoUrl,
          prNumber: payload.object_attributes?.iid
        });
        
        // Start pipeline execution in background
        this.pipelineRunner.runPipeline(pipeline.id, sourceBranch, commitSha).catch(error => {
          console.error(`Error running pipeline ${pipeline.id}:`, error);
        });
        
        return res.status(200).json({
          message: 'Build triggered successfully',
          pipelineRunId: pipelineRun.id
        });
      } else {
        // Unsupported event type
        return res.status(200).json({
          message: `Event ${event || payload.object_kind} is not configured to trigger pipeline`
        });
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Missing') || error.message.includes('Invalid')) {
          return res.status(400).json({ error: error.message });
        } else {
          console.error('GitLab webhook error:', error);
          return res.status(500).json({ error: 'Failed to process webhook' });
        }
      }
      return res.status(500).json({ error: 'Unknown error' });
    }
  }
}
