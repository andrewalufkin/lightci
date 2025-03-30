import * as fs from 'fs';
import * as path from 'path';
import mkdirp from 'mkdirp';

/**
 * Service for managing pipeline run artifacts storage
 */
export class RunStorageService {
  private baseStorageDir: string;

  constructor() {
    this.baseStorageDir = process.env.RUN_STORAGE_DIR || '/tmp/lightci/runs';
    this.ensureStorageDir();
  }

  /**
   * Ensure storage directory exists with proper permissions
   */
  private ensureStorageDir(): void {
    try {
      mkdirp.sync(this.baseStorageDir);
      console.log(`[RunStorageService] Ensured run storage directory exists: ${this.baseStorageDir}`);
    } catch (error) {
      console.error(`[RunStorageService] Error creating storage directory: ${error.message}`);
    }
  }

  /**
   * Get the path for a specific run
   */
  getRunPath(runId: string): string {
    return path.join(this.baseStorageDir, runId);
  }

  /**
   * Create a directory for a specific run
   */
  createRunDirectory(runId: string): string {
    const runPath = this.getRunPath(runId);
    mkdirp.sync(runPath);
    return runPath;
  }

  /**
   * Store content for a run
   */
  storeRunContent(runId: string, filename: string, content: string | Buffer): string {
    const runPath = this.createRunDirectory(runId);
    const filePath = path.join(runPath, filename);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  /**
   * Read content from a run
   */
  readRunContent(runId: string, filename: string): Buffer {
    const filePath = path.join(this.getRunPath(runId), filename);
    return fs.readFileSync(filePath);
  }

  /**
   * Check if run content exists
   */
  runContentExists(runId: string, filename: string): boolean {
    const filePath = path.join(this.getRunPath(runId), filename);
    return fs.existsSync(filePath);
  }

  /**
   * Delete a run directory and all its contents
   */
  deleteRun(runId: string): void {
    const runPath = this.getRunPath(runId);
    if (fs.existsSync(runPath)) {
      fs.rmSync(runPath, { recursive: true, force: true });
    }
  }

  /**
   * List all files in a run directory
   */
  listRunFiles(runId: string): string[] {
    const runPath = this.getRunPath(runId);
    if (!fs.existsSync(runPath)) {
      return [];
    }
    return fs.readdirSync(runPath);
  }
} 