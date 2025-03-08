import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import createTestApp from './utils/testApp';
import { testDb } from './utils/testDb';
import { generateJWT } from '../utils/auth.utils';
import { EngineService } from '../services/engine.service';
import { Artifact } from '../models/Artifact';
import { PipelineRun } from '@prisma/client';
import { jest } from '@jest/globals';
import { Build } from '../models/Build';
import { Pipeline } from '../models/Pipeline';

// Add this type to extend PipelineRun with the fields we need
interface ExtendedPipelineRun extends PipelineRun {
}

describe('Artifact Endpoints', () => {
  let app: any;
  let testUserId: string;
  let authToken: string;
  let pipelineId: string;
  let runId: string;
  let artifactsDir: string;
  let engineService: EngineService;
  let artifact: Artifact;
  let artifactId: string;

  beforeAll(async () => {
    app = await createTestApp();
    process.env.JWT_SECRET = 'test-secret';
    artifactsDir = path.join(process.cwd(), 'test-artifacts');
    await fsPromises.mkdir(artifactsDir, { recursive: true });
    
    // Get the EngineService instance from the test app
    engineService = app.get('EngineService');
    if (!engineService) {
      throw new Error('EngineService not found in test app');
    }

    // Mock the getPipelineRun method
    jest.spyOn(engineService, 'getPipelineRun').mockImplementation(async () => {
      const run = await testDb.pipelineRun.findUnique({
        where: { id: runId }
      });
      const now = new Date();
      const expireAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
      return {
        id: runId,
        pipelineId,
        status: 'completed',
        branch: 'main',
        commit: '123abc',
        startedAt: now,
        completedAt: now,
        stepResults: [],
        logs: [],
        error: null,
        artifactsPath: run?.artifactsPath || '',
        artifactsCollected: true,
        artifactsCount: 0,
        artifactsSize: 0,
        artifactsExpireAt: expireAt
      } as ExtendedPipelineRun;
    });

    // Mock the getBuild method
    jest.spyOn(engineService, 'getBuild').mockImplementation(async (buildId) => {
      const now = new Date();
      const build: Build = {
        id: buildId,
        pipelineId,
        status: 'success',
        branch: 'main',
        commit: '123abc',
        startedAt: now.toISOString(),
        completedAt: now.toISOString(),
        stepResults: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      return build;
    });

    // Mock the getPipeline method
    jest.spyOn(engineService, 'getPipeline').mockImplementation(async () => {
      const now = new Date();
      const pipeline: Pipeline = {
        id: pipelineId,
        name: 'Test Pipeline',
        repository: 'https://github.com/user/repo',
        workspaceId: 'test-workspace',
        description: 'Test pipeline for artifacts',
        defaultBranch: 'main',
        status: 'completed',
        steps: [],
        triggers: {
          events: ['push'],
          branches: ['main']
        },
        schedule: {},
        webhookConfig: {},
        artifactsEnabled: true,
        artifactPatterns: ['**/*.txt', '**/*.log', '**/*.json', '**/*.png', '**/*.zip'],
        artifactRetentionDays: 7,
        artifactStorageType: 'local',
        artifactStorageConfig: {},
        deploymentEnabled: false,
        deploymentPlatform: undefined,
        deploymentConfig: undefined,
        createdAt: now,
        updatedAt: now,
        createdById: testUserId
      };
      return pipeline;
    });

    // Mock the createArtifact method
    jest.spyOn(engineService, 'createArtifact').mockImplementation(async (options) => {
      const now = new Date();
      const id = `${options.buildId}-${Buffer.from(options.name).toString('base64')}`;

      // Create the artifact in the database
      const artifact = await testDb.artifact.create({
        data: {
          id,
          buildId: options.buildId,
          name: options.name,
          path: options.name,
          size: options.size || 0,
          contentType: options.contentType || 'application/octet-stream',
          metadata: options.metadata || {},
          createdAt: now,
          updatedAt: now
        }
      });

      // Create the file in the artifacts directory
      const filePath = path.join(artifactsDir, options.buildId, options.name);
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, 'Test content');

      return {
        id: artifact.id,
        buildId: artifact.buildId,
        name: artifact.name,
        path: artifact.path,
        size: artifact.size,
        contentType: artifact.contentType || 'application/octet-stream',
        metadata: artifact.metadata as Record<string, string>,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt
      };
    });

    // Mock the deleteArtifact method
    jest.spyOn(engineService, 'deleteArtifact').mockImplementation(async (id) => {
      console.log('[TEST] Deleting artifact with ID:', id);
      
      // Get the artifact first to get the correct path
      const artifact = await testDb.artifact.findUnique({
        where: { id }
      });
      console.log('[TEST] Found artifact to delete:', artifact);

      if (artifact) {
        // Get the run to get the artifacts path
        const run = await testDb.pipelineRun.findUnique({
          where: { id: artifact.buildId }
        });
        console.log('[TEST] Found run for artifact:', run);

        if (run?.artifactsPath) {
          const filePath = path.join(run.artifactsPath, artifact.path);
          console.log('[TEST] Deleting file at path:', filePath);
          if (fs.existsSync(filePath)) {
            await fsPromises.unlink(filePath);
          }
        }

        // Delete the artifact from the database
        await testDb.artifact.delete({
          where: { id }
        });
      }
    });
  });

  beforeEach(async () => {
    // Create test user and get auth token
    testUserId = uuidv4();
    const user = await testDb.user.create({
      data: {
        id: testUserId,
        email: `test-${uuidv4()}@example.com`,
        passwordHash: 'dummy_hash',
        fullName: 'Test User',
        accountStatus: 'active',
        accountTier: 'free'
      }
    });
    authToken = generateJWT(user);

    // Create test pipeline
    const pipeline = await testDb.pipeline.create({
      data: {
        id: pipelineId = uuidv4(),
        name: 'Test Pipeline',
        repository: 'https://github.com/user/repo',
        defaultBranch: 'main',
        steps: [],
        createdById: testUserId,
        artifactsEnabled: true,
        artifactPatterns: ['**/*.txt', '**/*.log', '**/*.json', '**/*.png', '**/*.zip'],
        artifactRetentionDays: 7
      }
    });

    // Generate run ID first
    runId = uuidv4();

    // Create test pipeline run using the pre-generated ID
    const run = await testDb.pipelineRun.create({
      data: {
        id: runId,
        pipelineId: pipeline.id,
        status: 'completed',
        branch: 'main',
        commit: '123abc',
        startedAt: new Date(),
        completedAt: new Date(),
        stepResults: [],
        logs: [],
        artifactsPath: path.join(artifactsDir, runId),
      }
    });

    // Create test artifacts directory for the run
    await fsPromises.mkdir(run.artifactsPath!, { recursive: true });

    // Create a test artifact
    const testArtifact = await engineService.createArtifact({
      buildId: runId,
      name: 'test.txt',
      contentType: 'text/plain',
      size: 1024,
      metadata: { commit: '123abc' }
    });
    artifact = testArtifact;
    artifactId = testArtifact.id;
    console.log('[TEST] Created test artifact with ID:', artifactId);

    // Create test file with actual content
    const filePath = path.join(run.artifactsPath!, 'test.txt');
    await fsPromises.writeFile(filePath, 'Test content');

    // Mock the getArtifact method with the current artifact
    jest.spyOn(engineService, 'getArtifact').mockImplementation(async (id) => {
      console.log('[TEST] getArtifact called with ID:', id);
      console.log('[TEST] Current artifactId:', artifactId);
      console.log('[TEST] Current runId:', runId);
      console.log('[TEST] ID comparison:', {
        receivedId: id,
        expectedId: artifactId,
        matches: id === artifactId,
        receivedIdLength: id.length,
        expectedIdLength: artifactId.length,
        receivedIdParts: id.split('-'),
        expectedIdParts: artifactId.split('-')
      });

      // Split on the last occurrence of '-' to separate UUID from base64 filename
      const lastDashIndex = id.lastIndexOf('-');
      const requestedRunId = id.substring(0, lastDashIndex);
      const encodedPath = id.substring(lastDashIndex + 1);
      
      console.log('[TEST] Parsed ID parts:', {
        requestedRunId,
        encodedPath,
        decodedPath: encodedPath ? Buffer.from(encodedPath, 'base64').toString() : null,
        matchesRunId: requestedRunId === runId
      });

      if (requestedRunId === runId) {
        console.log('[TEST] Found matching artifact');
        return {
          id: artifactId,
          buildId: runId,
          name: 'test.txt',
          path: 'test.txt',
          size: 1024,
          contentType: 'text/plain',
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date()
        };
      }
      console.log('[TEST] No matching artifact found');
      return null;
    });
  });

  afterEach(async () => {
    // Clean up test data
    await testDb.artifact.deleteMany({});
    await testDb.pipelineRun.deleteMany({});
    await testDb.pipeline.deleteMany({});
    await testDb.user.deleteMany({});
  });

  afterAll(async () => {
    // Clean up test artifacts directory
    await fsPromises.rm(artifactsDir, { recursive: true, force: true });
  });

  describe('POST /api/artifacts', () => {
    it('should upload an artifact with valid data', async () => {
      const artifactData = {
        buildId: runId,
        name: 'test2.txt',
        contentType: 'text/plain',
        size: 1024,
        metadata: {
          commit: '123abc',
          branch: 'main'
        }
      };

      const response = await request(app)
        .post('/api/artifacts')
        .set('Authorization', `Bearer ${authToken}`)
        .send(artifactData);

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body.name).toBe(artifactData.name);
      expect(response.body.size).toBe(artifactData.size);
      expect(response.body.contentType).toBe(artifactData.contentType);
      expect(response.body.metadata).toEqual(artifactData.metadata);

      // Verify artifact was created in database
      const artifact = await testDb.artifact.findUnique({
        where: { id: response.body.id }
      });
      expect(artifact).toBeTruthy();
      expect(artifact?.name).toBe(artifactData.name);
    });

    it('should validate file size limits', async () => {
      const maxSize = 100 * 1024 * 1024; // 100MB
      const artifactData = {
        buildId: runId,
        name: 'large.bin',
        size: maxSize + 1,
        contentType: 'application/octet-stream'
      };

      const response = await request(app)
        .post('/api/artifacts')
        .set('Authorization', `Bearer ${authToken}`)
        .send(artifactData);

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toMatch(/file size/i);
    });

    it('should handle different file types', async () => {
      const fileTypes = [
        { name: 'test-1.txt', type: 'text/plain' },
        { name: 'test-2.json', type: 'application/json' },
        { name: 'test-3.png', type: 'image/png' },
        { name: 'test-4.zip', type: 'application/zip' }
      ];

      for (const { name, type } of fileTypes) {
        const response = await request(app)
          .post('/api/artifacts')
          .set('Authorization', `Bearer ${authToken}`)
          .send({
            buildId: runId,
            name,
            contentType: type,
            size: 1024
          });

        expect(response.status).toBe(201);
        expect(response.body.contentType).toBe(type);
      }
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .post('/api/artifacts')
        .send({
          buildId: runId,
          name: 'test.txt',
          size: 1024
        });

      expect(response.status).toBe(401);
    });

    it('should validate artifact patterns', async () => {
      const response = await request(app)
        .post('/api/artifacts')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          buildId: runId,
          name: 'test.exe',
          size: 1024,
          contentType: 'application/x-msdownload'
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/pattern/i);
    });
  });

  describe('GET /api/artifacts/:id', () => {
    it('should download artifact by id', async () => {
      console.log('[TEST] Starting download test with artifactId:', artifactId);
      const response = await request(app)
        .get(`/api/artifacts/${artifactId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain');
      expect(response.headers['content-disposition']).toContain('test.txt');
    });

    it('should return 404 for non-existent artifact', async () => {
      const response = await request(app)
        .get(`/api/artifacts/${uuidv4()}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .get(`/api/artifacts/${artifactId}`);

      expect(response.status).toBe(401);
    });

    it('should handle missing files', async () => {
      // Delete the physical file but keep the database record
      await fsPromises.unlink(path.join(artifactsDir, runId, 'test.txt'));

      const response = await request(app)
        .get(`/api/artifacts/${artifactId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/file not found/i);
    });
  });

  describe('DELETE /api/artifacts/:id', () => {
    it('should delete artifact', async () => {
      console.log('[TEST] Starting delete test with artifactId:', artifactId);
      console.log('[TEST] Current user ID:', testUserId);
      
      // Verify artifact exists before deletion
      const beforeArtifact = await testDb.artifact.findUnique({
        where: { id: artifactId }
      });
      console.log('[TEST] Artifact before deletion:', beforeArtifact);

      // Verify pipeline run exists and has correct ownership
      const beforeRun = await testDb.pipelineRun.findUnique({
        where: { id: runId },
        include: {
          pipeline: {
            select: {
              createdById: true
            }
          }
        }
      });
      console.log('[TEST] Pipeline run before deletion:', beforeRun);

      const response = await request(app)
        .delete(`/api/artifacts/${artifactId}`)
        .set('Authorization', `Bearer ${authToken}`);

      console.log('[TEST] Delete response status:', response.status);
      console.log('[TEST] Delete response body:', response.body);

      expect(response.status).toBe(204);

      // Verify artifact was deleted from database
      const artifact = await testDb.artifact.findUnique({
        where: { id: artifactId }
      });
      console.log('[TEST] Artifact after deletion attempt:', artifact);
      expect(artifact).toBeNull();

      // Verify file was deleted
      const filePath = path.join(artifactsDir, runId, 'test.txt');
      const fileExists = fs.existsSync(filePath);
      console.log('[TEST] File exists after deletion:', fileExists);
      expect(fileExists).toBe(false);
    });

    it('should require authentication', async () => {
      const response = await request(app)
        .delete(`/api/artifacts/${artifactId}`);

      expect(response.status).toBe(401);
    });

    it('should handle non-existent artifacts', async () => {
      const response = await request(app)
        .delete(`/api/artifacts/${uuidv4()}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(response.status).toBe(404);
    });

    it('should validate user permissions', async () => {
      // Create another user
      const otherUser = await testDb.user.create({
        data: {
          id: uuidv4(),
          email: `other-${uuidv4()}@example.com`,
          passwordHash: 'dummy_hash',
          fullName: 'Other User',
          accountStatus: 'active',
          accountTier: 'free'
        }
      });
      console.log('[TEST] Created other user:', otherUser.id);
      const otherToken = generateJWT(otherUser);

      // Create a new pipeline owned by the other user
      const otherPipeline = await testDb.pipeline.create({
        data: {
          name: 'Other Pipeline',
          repository: 'https://github.com/other/repo',
          defaultBranch: 'main',
          steps: [],
          createdById: otherUser.id,
          artifactsEnabled: true,
          artifactPatterns: ['**/*.txt'],
          artifactRetentionDays: 7
        }
      });
      console.log('[TEST] Created other pipeline:', otherPipeline.id);

      // Create a run for the other pipeline
      const otherRun = await testDb.pipelineRun.create({
        data: {
          id: uuidv4(),
          pipelineId: otherPipeline.id,
          status: 'completed',
          branch: 'main',
          commit: '123abc',
          startedAt: new Date(),
          completedAt: new Date(),
          stepResults: [],
          logs: [],
          artifactsPath: path.join(artifactsDir, runId),
        }
      });
      console.log('[TEST] Created other run:', otherRun.id);

      // Verify artifact exists before attempting deletion
      const beforeArtifact = await testDb.artifact.findUnique({
        where: { id: artifactId }
      });
      console.log('[TEST] Artifact before permission test:', beforeArtifact);

      // Try to delete the artifact as the other user
      const response = await request(app)
        .delete(`/api/artifacts/${artifactId}`)
        .set('Authorization', `Bearer ${otherToken}`);

      console.log('[TEST] Permission test response status:', response.status);
      console.log('[TEST] Permission test response body:', response.body);

      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/permission denied/i);

      // Verify artifact still exists
      const artifact = await testDb.artifact.findUnique({
        where: { id: artifactId }
      });
      console.log('[TEST] Artifact after permission test:', artifact);
      expect(artifact).toBeTruthy();
    });
  });
}); 