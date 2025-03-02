// Script to apply the migration directly to the database
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the current file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the migration file
const migrationFilePath = path.join(__dirname, 'prisma/migrations/20250301050000_drop_org_fk_constraint/migration.sql');

// Read the migration SQL
const migrationSQL = fs.readFileSync(migrationFilePath, 'utf8');

// Get the database URL from environment
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('DATABASE_URL environment variable is not set');
  process.exit(1);
}

// Extract database name from the URL
const dbName = dbUrl.split('/').pop().split('?')[0];

// Command to apply the migration
const command = `psql "${dbUrl}" -c "${migrationSQL.replace(/"/g, '\\"')}"`;

console.log('Applying migration...');
exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error(`Error applying migration: ${error.message}`);
    return;
  }
  if (stderr) {
    console.error(`Migration stderr: ${stderr}`);
    return;
  }
  console.log(`Migration applied successfully: ${stdout}`);
  
  // Update the _prisma_migrations table to record this migration
  const recordMigrationCommand = `psql "${dbUrl}" -c "INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES ('$(uuidgen)', 'drop_org_fk_constraint', NOW(), '20250301050000_drop_org_fk_constraint', '', NULL, NOW(), 1) ON CONFLICT DO NOTHING;"`;
  
  exec(recordMigrationCommand, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error recording migration: ${error.message}`);
      return;
    }
    console.log('Migration recorded in _prisma_migrations table');
  });
}); 