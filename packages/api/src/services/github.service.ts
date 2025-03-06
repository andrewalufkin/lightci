import { Octokit } from '@octokit/rest';
import * as crypto from 'crypto';

export class GitHubService {
  private webhookSecret: string;
  private apiBaseUrl: string;

  constructor(apiBaseUrl: string) {
    this.webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || 'your-webhook-secret';
    this.apiBaseUrl = apiBaseUrl;
  }

  private createOctokit(token: string): Octokit {
    return new Octokit({
      auth: token
    });
  }

  private extractRepoInfo(repoUrl: string): { owner: string; repo: string } {
    const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) {
      throw new Error('Invalid GitHub repository URL');
    }
    return {
      owner: match[1],
      repo: match[2]
    };
  }

  async createWebhook(repoUrl: string, token: string): Promise<{ id: number; url: string }> {
    try {
      const octokit = this.createOctokit(token);
      const { owner, repo } = this.extractRepoInfo(repoUrl);

      const webhookUrl = `${this.apiBaseUrl}/api/webhooks/github`;
      
      // Create webhook
      const response = await octokit.repos.createWebhook({
        owner,
        repo,
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret: this.webhookSecret,
        },
        events: ['push', 'pull_request'],
        active: true
      });

      return {
        id: response.data.id,
        url: response.data.config?.url || webhookUrl
      };
    } catch (error) {
      console.error('Failed to create GitHub webhook:', error);
      throw error;
    }
  }

  async deleteWebhook(repoUrl: string, webhookId: number, token: string): Promise<void> {
    try {
      const octokit = this.createOctokit(token);
      const { owner, repo } = this.extractRepoInfo(repoUrl);

      await octokit.repos.deleteWebhook({
        owner,
        repo,
        hook_id: webhookId
      });
    } catch (error) {
      console.error('Failed to delete GitHub webhook:', error);
      throw error;
    }
  }

  verifyWebhookSignature(payload: string, signature: string): boolean {
    const hmac = crypto.createHmac('sha256', this.webhookSecret);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  }
} 