import { jest } from '@jest/globals';
import createTestApp from './utils/testApp';
import { testUser, createTestUser } from './fixtures/users';
import { testDb } from './utils/testDb';
import * as crypto from 'crypto';

jest.setTimeout(60000); // Increase timeout for database operations

/**
 * Helper function to wait for database operations to complete
 * This helps prevent race conditions in tests
 */
const waitForDbOperations = async (ms = 1000) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Helper function to check if pipeline runs exist using direct database queries
 * This bypasses transaction isolation issues
 */
const checkPipelineRuns = async (options: { commit?: string; branch?: string }) => {
  const { commit, branch } = options;
  
  try {
    // Use the database client directly with raw query
    const results = await testDb.$queryRawUnsafe<Array<{
      id: string;
      commit: string;
      branch: string;
      status: string;
      createdAt: Date;
    }>>(
      `SELECT * FROM "pipeline_runs" 
       WHERE ($1::text IS NULL OR "commit" = $1)
       AND ($2::text IS NULL OR "branch" = $2)
       ORDER BY "started_at" DESC LIMIT 10`,
      commit || null,
      branch || null
    );
    
    return results;
  } catch (error) {
    console.error('Error querying database:', error);
    return [];
  }
};

describe('Webhook Endpoints', () => {
  let userId: string;
  let pipelineId: string;
  let app: ReturnType<typeof createTestApp>;
  let request: any;

  beforeAll(async () => {
    // Set up environment variables for testing
    process.env.GITHUB_WEBHOOK_SECRET = 'your-webhook-secret';
    process.env.GITLAB_WEBHOOK_SECRET = 'your-webhook-secret';
    
    // Ensure database connection is established
    await testDb.$connect();
    app = await createTestApp();
    
    // Import and configure supertest
    const st = (await import('supertest')) as any;
    request = (st.default || st)(app);
  });

  afterAll(async () => {
    // Clean up environment variables
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITLAB_WEBHOOK_SECRET;
    
    // Clean up database connection
    await testDb.$disconnect();
  });

  beforeEach(async () => {
    try {
      // Clean up any existing data
      await testDb.pipelineRun.deleteMany();
      await testDb.pipeline.deleteMany();
      await testDb.user.deleteMany();

      const user = await createTestUser();
      userId = user.id;

      // Create a test pipeline
      console.log('[Test Setup] Creating test pipeline...');
      const pipeline = await testDb.pipeline.create({
        data: {
          name: 'Test Pipeline',
          repository: 'https://github.com/user/repo',
          defaultBranch: 'main',
          steps: [
            {
              name: 'Build',
              command: 'npm run build'
            }
          ],
          createdById: userId,
          triggers: {
            events: ['push', 'pull_request'],
            branches: ['main', 'develop', 'release/*']
          },
          webhookConfig: {
            secret: 'your-webhook-secret'
          }
        }
      });
      console.log('[Test Setup] Created pipeline:', {
        id: pipeline.id,
        repository: pipeline.repository,
        triggers: pipeline.triggers
      });
      pipelineId = pipeline.id;
    } catch (error) {
      console.error('[Test Setup] Error:', error);
      throw error;
    }
  });

  afterEach(async () => {
    try {
      await testDb.pipelineRun.deleteMany();
      await testDb.pipeline.deleteMany();
      await testDb.user.deleteMany();
    } catch (error) {
      console.error('[Test Cleanup] Error:', error);
      throw error;
    }
  });

  describe('GitHub Webhooks', () => {
    /**
     * Creates a GitHub webhook signature for testing
     * This must exactly match the format expected by the webhook controller
     */
    const createSignature = (payload: any, secret: string) => {
      const hmac = crypto.createHmac('sha256', secret);
      const rawBody = JSON.stringify(payload);
      hmac.update(rawBody);
      return `sha256=${hmac.digest('hex')}`;
    };

    it('should handle push event', async () => {
      // First, clear any existing pipeline runs
      await testDb.pipelineRun.deleteMany({
        where: {
          commit: '123abc',
          branch: 'main'
        }
      });

      const payload = {
        ref: 'refs/heads/main',
        repository: {
          clone_url: 'https://github.com/user/repo',
          html_url: 'https://github.com/user/repo'
        },
        head_commit: {
          id: '123abc',
          message: 'Test commit'
        },
        after: '123abc'
      };

      const signature = createSignature(payload, 'your-webhook-secret');

      const response = await request
        .post('/api/webhooks/github')
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Event', 'push')
        .set('X-GitHub-Delivery', 'test-delivery-id')
        .send(payload);

      console.log('[Test] Webhook response:', {
        status: response.status,
        body: response.body
      });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Build triggered successfully');
      
      // Use a longer wait time to ensure all operations complete
      console.log('[Test] Waiting for DB operations to complete...');
      await waitForDbOperations(2000); // Increased to 2 seconds
      
      // First try normal Prisma query
      console.log('[Test] Checking pipeline runs with Prisma...');
      const prismaRuns = await testDb.pipelineRun.findMany({
        where: {
          commit: '123abc',
          branch: 'main'
        }
      });
      console.log(`[Test] Found ${prismaRuns.length} pipeline runs with Prisma`);
      
      // Check all pipeline runs directly
      console.log('[Test] Checking all pipeline runs in database...');
      const allRuns = await testDb.$queryRawUnsafe<Array<{
        id: string;
        commit: string;
        branch: string;
        status: string;
        createdAt: Date;
      }>>('SELECT * FROM "pipeline_runs"');
      console.log(`[Test] Found ${allRuns.length} total pipeline runs in database:`, allRuns);
      
      // Verify pipeline run was created using direct query
      console.log('[Test] Checking pipeline runs for specific commit...');
      const runs = await checkPipelineRuns({ commit: '123abc' });
      
      console.log(`[Test] Found ${runs.length} pipeline runs for commit 123abc`);
      expect(runs.length).toBeGreaterThan(0);
      
      // Find the matching run
      const matchingRun = runs.find(run => run.branch === 'main');
      console.log(`[Test] Matching run for main branch:`, matchingRun || 'NOT FOUND');
      expect(matchingRun).toBeTruthy();
      if (!matchingRun) {
        throw new Error('Expected to find a pipeline run for main branch');
      }
      expect(matchingRun.status).toBe('completed');
    });

    it('should handle pull request event', async () => {
      // First, clear any existing pipeline runs
      await testDb.pipelineRun.deleteMany({
        where: {
          commit: '456def'
        }
      });

      const payload = {
        action: 'opened',
        pull_request: {
          head: {
            ref: 'feature',
            sha: '456def'
          },
          base: {
            ref: 'main'
          }
        },
        repository: {
          full_name: 'user/repo',
          html_url: 'https://github.com/user/repo'
        }
      };

      const signature = createSignature(payload, 'your-webhook-secret');

      const response = await request
        .post('/api/webhooks/github')
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Event', 'pull_request')
        .set('X-GitHub-Delivery', 'test-delivery-id')
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Build triggered successfully');
      
      // Use a longer wait time to ensure all operations complete
      await waitForDbOperations(1000);

      // Verify pipeline run was created using direct query
      const runs = await checkPipelineRuns({ commit: '456def' });
      
      console.log(`[Test] Found ${runs.length} pipeline runs for PR with commit 456def`);
      expect(runs.length).toBeGreaterThan(0);
      
      // Find the matching run
      const matchingRun = runs.find(run => run.branch === 'feature');
      console.log(`[Test] Matching run for feature branch:`, matchingRun || 'NOT FOUND');
      expect(matchingRun).toBeTruthy();
      if (!matchingRun) {
        throw new Error('Expected to find a pipeline run for feature branch');
      }
      expect(matchingRun.status).toBe('completed');
    });

    it('should respect branch trigger configuration', async () => {
      // Update pipeline to only trigger on specific branches
      await testDb.pipeline.update({
        where: { id: pipelineId },
        data: {
          triggers: {
            events: ['push', 'pull_request'],
            branches: ['main', 'release/*']
          }
        }
      });

      // Clear previous pipeline runs
      await testDb.pipelineRun.deleteMany({
        where: {
          branch: 'feature',
          commit: '123abc'
        }
      });

      // Verify the update took effect
      const updatedPipeline = await testDb.pipeline.findUnique({
        where: { id: pipelineId }
      });
      if (!updatedPipeline) {
        throw new Error('Failed to find updated pipeline');
      }
      console.log(`[Test] Updated pipeline triggers:`, updatedPipeline.triggers);

      // Get the webhook controller from the Express app
      const webhookController = (app as any).get('WebhookController');
      if (!webhookController) {
        throw new Error('WebhookController not found in app instance');
      }
      const shouldTrigger = webhookController.shouldTriggerForBranch('feature', updatedPipeline.triggers);
      console.log(`[Test] Should trigger for branch 'feature': ${shouldTrigger}`);
      expect(shouldTrigger).toBe(false);

      const payload = {
        ref: 'refs/heads/feature',
        repository: {
          clone_url: 'https://github.com/user/repo',
          html_url: 'https://github.com/user/repo'
        },
        after: '123abc'
      };

      const signature = createSignature(payload, 'your-webhook-secret');

      const response = await request
        .post('/api/webhooks/github')
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Event', 'push')
        .set('X-GitHub-Delivery', 'test-delivery-id')
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Branch feature is not configured to trigger pipeline');

      // Wait for any async operations to complete
      await waitForDbOperations(500);

      // Verify no pipeline run was created
      const runs = await testDb.pipelineRun.findMany({
        where: {
          branch: 'feature',
          commit: '123abc'
        }
      });
      expect(runs).toHaveLength(0);
    });

    it('should handle wildcard branch trigger', async () => {
      // Update pipeline to use wildcard branch trigger
      await testDb.pipeline.update({
        where: { id: pipelineId },
        data: {
          triggers: {
            events: ['push', 'pull_request'],
            branches: ['*']
          }
        }
      });

      // Clear previous runs
      await testDb.pipelineRun.deleteMany({
        where: {
          branch: 'any-branch',
          commit: '123abc'
        }
      });

      // Verify the update took effect
      const updatedPipeline = await testDb.pipeline.findUnique({
        where: { id: pipelineId }
      });
      if (!updatedPipeline) {
        throw new Error('Failed to find updated pipeline');
      }
      console.log(`[Test] Updated pipeline triggers for wildcard:`, updatedPipeline.triggers);

      // Get the webhook controller from the Express app
      const webhookController = (app as any).get('WebhookController');
      if (!webhookController) {
        throw new Error('WebhookController not found in app instance');
      }
      const shouldTrigger = webhookController.shouldTriggerForBranch('any-branch', updatedPipeline.triggers);
      console.log(`[Test] Should trigger for branch 'any-branch' with wildcard: ${shouldTrigger}`);
      expect(shouldTrigger).toBe(true);

      const payload = {
        ref: 'refs/heads/any-branch',
        repository: {
          clone_url: 'https://github.com/user/repo',
          html_url: 'https://github.com/user/repo'
        },
        after: '123abc'
      };

      const signature = createSignature(payload, 'your-webhook-secret');

      const response = await request
        .post('/api/webhooks/github')
        .set('X-Hub-Signature-256', signature)
        .set('X-GitHub-Event', 'push')
        .set('X-GitHub-Delivery', 'test-delivery-id')
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Build triggered successfully');
      
      // Wait for DB operations to complete
      await waitForDbOperations(1000);

      // Verify pipeline run was created using direct query
      const runs = await checkPipelineRuns({ branch: 'any-branch', commit: '123abc' });
      
      console.log(`[Test] Found ${runs.length} pipeline runs for wildcard branch`);
      expect(runs.length).toBeGreaterThan(0);
      
      if (runs.length > 0) {
        const matchingRun = runs[0];
        expect(matchingRun.status).toBe('completed');
      }
    });
  });

  describe('GitLab Webhooks', () => {
    it('should handle push event', async () => {
      // Clear previous runs
      await testDb.pipelineRun.deleteMany({
        where: {
          branch: 'main',
          commit: '123abc'
        }
      });

      const payload = {
        ref: 'refs/heads/main',
        project: {
          path_with_namespace: 'user/repo'
        },
        after: '123abc',
        commits: [
          {
            id: '123abc',
            message: 'Test commit'
          }
        ]
      };

      const response = await request
        .post('/api/webhooks/gitlab')
        .set('X-Gitlab-Token', 'your-webhook-secret')
        .set('X-Gitlab-Event', 'Push Hook')
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Build triggered successfully');
      
      // Wait for DB operations to complete
      await waitForDbOperations(1000);

      // Verify pipeline run was created using direct query
      const runs = await checkPipelineRuns({ commit: '123abc' });
      
      console.log(`[Test] Found ${runs.length} pipeline runs for GitLab push`);
      expect(runs.length).toBeGreaterThan(0);
      
      // Find the matching run - use a more flexible approach
      const matchingRun = runs.find(run => run.branch && run.branch.includes('main'));
      console.log(`[Test] Matching run for main branch:`, matchingRun || 'NOT FOUND');
      expect(matchingRun).toBeTruthy();
      if (!matchingRun) {
        throw new Error('Expected to find a pipeline run for main branch');
      }
      expect(matchingRun.status).toBe('completed');
    });

    it('should handle merge request event', async () => {
      // Clear previous runs
      await testDb.pipelineRun.deleteMany({
        where: {
          branch: 'feature',
          commit: '456def'
        }
      });

      const payload = {
        object_kind: 'merge_request',
        object_attributes: {
          source_branch: 'feature',
          source_sha: '456def',
          target_branch: 'main',
          state: 'opened'
        },
        project: {
          path_with_namespace: 'user/repo'
        }
      };

      const response = await request
        .post('/api/webhooks/gitlab')
        .set('X-Gitlab-Token', 'your-webhook-secret')
        .set('X-Gitlab-Event', 'Merge Request Hook')
        .send(payload);

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Build triggered successfully');
      
      // Wait for DB operations to complete
      await waitForDbOperations(1000);

      // Verify pipeline run was created using direct query
      const runs = await checkPipelineRuns({ commit: '456def' });
      
      console.log(`[Test] Found ${runs.length} pipeline runs for GitLab MR`);
      expect(runs.length).toBeGreaterThan(0);
      
      // Find the matching run
      const matchingRun = runs.find(run => run.branch === 'feature');
      console.log(`[Test] Matching run for feature branch:`, matchingRun || 'NOT FOUND');
      expect(matchingRun).toBeTruthy();
      if (!matchingRun) {
        throw new Error('Expected to find a pipeline run for feature branch');
      }
      expect(matchingRun.status).toBe('completed');
    });
  });
}); 