import { PrismaClient } from '@prisma/client';
import { BillingService } from '../services/billing.service';
import { EngineService } from '../services/engine.service';
import { ArtifactCleanupService } from '../services/artifact-cleanup.service';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { v4 as uuid } from 'uuid';

const testDb = new PrismaClient();

interface UsageRecord {
  id: string;
  user_id: string;
  usage_type: string;
  quantity: number;
  metadata: {
    artifact_id: string;
    action: string;
  };
  timestamp: Date;
}

describe('Storage Tracking Lifecycle', () => {
  let billingService: BillingService;
  let engineService: EngineService;
  let cleanupService: ArtifactCleanupService;
  let testUserId: string;
  let testPipelineId: string;
  let testRunId: string;
  let artifactsDir: string;

  beforeAll(async () => {
    // Create test directories
    artifactsDir = path.join(process.cwd(), 'test-artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    process.env.ARTIFACTS_PATH = artifactsDir;

    billingService = new BillingService(testDb);
    engineService = new EngineService('test-url');
    cleanupService = new ArtifactCleanupService();
  });

  beforeEach(async () => {
    // Clean up any existing test data
    await testDb.$executeRaw`TRUNCATE TABLE usage_records CASCADE`;
    await testDb.$executeRaw`TRUNCATE TABLE artifacts CASCADE`;
    await testDb.$executeRaw`TRUNCATE TABLE pipeline_runs CASCADE`;
    await testDb.$executeRaw`TRUNCATE TABLE pipelines CASCADE`;
    await testDb.$executeRaw`TRUNCATE TABLE users CASCADE`;

    // Create test user
    const user = await testDb.user.create({
      data: {
        email: 'test@example.com',
        username: 'testuser',
        passwordHash: 'test-hash',
        accountStatus: 'active',
        accountTier: 'free'
      }
    });
    testUserId = user.id;

    // Create test pipeline
    const pipeline = await testDb.pipeline.create({
      data: {
        name: 'Test Pipeline',
        status: 'active',
        repository: 'test/repo',
        defaultBranch: 'main',
        steps: [],
        createdBy: {
          connect: {
            id: testUserId
          }
        },
        artifactsEnabled: true,
        artifactRetentionDays: 1 // Short retention for testing cleanup
      }
    });
    testPipelineId = pipeline.id;

    // Create test pipeline run
    const run = await testDb.pipelineRun.create({
      data: {
        status: 'completed',
        branch: 'main',
        commit: 'test-commit',
        artifactsCollected: true,
        artifactsPath: path.join(artifactsDir, uuid()),
        startedAt: new Date(),
        completedAt: new Date(),
        pipeline: {
          connect: {
            id: testPipelineId
          }
        }
      }
    });
    testRunId = run.id;

    // Create run artifacts directory
    await fs.mkdir(run.artifactsPath!, { recursive: true });
  });

  afterAll(async () => {
    // Clean up test directories
    await fs.rm(artifactsDir, { recursive: true, force: true });
    await testDb.$disconnect();
  });

  describe('Artifact Creation', () => {
    it('should create usage record when artifact is created', async () => {
      // Create a test artifact
      const artifactSize = 1024; // 1KB
      const artifact = await engineService.createArtifact({
        buildId: testRunId,
        name: 'test.txt',
        size: artifactSize,
        contentType: 'text/plain'
      });

      // Verify usage record was created
      const usageRecords = await testDb.$queryRaw<UsageRecord[]>`
        SELECT * FROM usage_records 
        WHERE user_id = ${testUserId} 
        AND usage_type = 'artifact_storage'
      `;

      expect(usageRecords).toHaveLength(1);
      expect(usageRecords[0]).toMatchObject({
        quantity: artifactSize / (1024 * 1024), // Should be converted to MB
        metadata: expect.objectContaining({
          artifact_id: artifact.id,
          action: 'created'
        })
      });
    });
  });

  describe('Artifact Deletion', () => {
    it('should create negative usage record when artifact is manually deleted', async () => {
      // First create the artifact through the engine service
      const artifactSize = 1024; // 1KB
      const artifactName = 'test.txt';
      
      console.log('Creating artifact record...');
      // Create the artifact record
      const artifact = await engineService.createArtifact({
        buildId: testRunId,
        name: artifactName,
        size: artifactSize,
        contentType: 'text/plain'
      });
      
      console.log(`Created artifact with ID: ${artifact.id}`);
      
      // Get the run to find the artifact path
      const run = await testDb.pipelineRun.findUnique({ where: { id: testRunId } });
      if (!run?.artifactsPath) throw new Error('Run artifacts path not found');
      console.log(`Run artifacts path: ${run.artifactsPath}`);
      
      // Create the file with actual content (the createArtifact method only creates an empty file)
      const filePath = path.join(run.artifactsPath, artifact.path);
      console.log(`Creating file with content at path: ${filePath}`);
      await fs.writeFile(filePath, Buffer.alloc(artifactSize));
      
      // Verify the file exists
      const fileExists = fsSync.existsSync(filePath);
      console.log(`File exists at ${filePath}: ${fileExists}`);
      
      // Then delete it
      console.log(`Deleting artifact with ID: ${artifact.id}`);
      await engineService.deleteArtifact(artifact.id);

      // Verify usage records
      const usageRecords = await testDb.$queryRaw<UsageRecord[]>`
        SELECT * FROM usage_records 
        WHERE user_id = ${testUserId} 
        AND usage_type = 'artifact_storage'
        ORDER BY timestamp ASC
      `;

      expect(usageRecords).toHaveLength(2);
      expect(usageRecords[1]).toMatchObject({
        quantity: -(artifactSize / (1024 * 1024)), // Should be negative MB
        metadata: expect.objectContaining({
          artifact_id: artifact.id,
          action: 'deleted'
        })
      });
    });

    it('should create negative usage records when pipeline is deleted', async () => {
      // Create multiple artifacts
      const artifactSize = 1024; // 1KB
      const artifacts = await Promise.all([
        engineService.createArtifact({
          buildId: testRunId,
          name: 'test1.txt',
          size: artifactSize,
          contentType: 'text/plain'
        }),
        engineService.createArtifact({
          buildId: testRunId,
          name: 'test2.txt',
          size: artifactSize,
          contentType: 'text/plain'
        })
      ]);

      // Delete the pipeline
      await engineService.deletePipeline(testPipelineId);

      // Verify usage records
      const usageRecords = await testDb.$queryRaw<UsageRecord[]>`
        SELECT * FROM usage_records 
        WHERE user_id = ${testUserId} 
        AND usage_type = 'artifact_storage'
        ORDER BY timestamp ASC
      `;

      // Should have 2 creation records and 2 deletion records
      expect(usageRecords).toHaveLength(4);
      
      // Verify the last two records are deletions
      const deletionRecords = usageRecords.slice(2);
      deletionRecords.forEach((record, i) => {
        expect(record).toMatchObject({
          quantity: -(artifactSize / (1024 * 1024)),
          metadata: expect.objectContaining({
            artifact_id: artifacts[i].id,
            action: 'deleted'
          })
        });
      });
    });
  });

  describe('Automatic Cleanup', () => {
    it('should create negative usage records when artifacts are automatically cleaned up', async () => {
      // Create an artifact
      const artifactSize = 1024; // 1KB
      const artifact = await engineService.createArtifact({
        buildId: testRunId,
        name: 'test.txt',
        size: artifactSize,
        contentType: 'text/plain'
      });

      // Create the actual file
      const run = await testDb.pipelineRun.findUnique({ where: { id: testRunId } });
      if (!run?.artifactsPath) throw new Error('Run artifacts path not found');
      const artifactPath = path.join(run.artifactsPath, artifact.path);
      await fs.writeFile(artifactPath, Buffer.alloc(artifactSize));

      // Set the expiration date to the past
      await testDb.pipelineRun.update({
        where: { id: testRunId },
        data: {
          artifactsExpireAt: new Date(Date.now() - 24 * 60 * 60 * 1000) // 1 day ago
        }
      });

      // Run the cleanup
      await cleanupService.cleanup();

      // Verify usage records
      const usageRecords = await testDb.$queryRaw<UsageRecord[]>`
        SELECT * FROM usage_records 
        WHERE user_id = ${testUserId} 
        AND usage_type = 'artifact_storage'
        ORDER BY timestamp ASC
      `;

      expect(usageRecords).toHaveLength(2);
      expect(usageRecords[1]).toMatchObject({
        quantity: -(artifactSize / (1024 * 1024)),
        metadata: expect.objectContaining({
          artifact_id: artifact.id,
          action: 'deleted'
        })
      });

      // Verify artifacts were actually deleted
      const artifactExists = await testDb.artifact.findUnique({
        where: { id: artifact.id }
      });
      expect(artifactExists).toBeNull();
    });
  });
}); 