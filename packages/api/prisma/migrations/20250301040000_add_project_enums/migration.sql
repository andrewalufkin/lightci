-- Drop existing foreign key constraints
ALTER TABLE "pipelines" DROP CONSTRAINT IF EXISTS "pipelines_project_id_fkey";
ALTER TABLE "repository_connections" DROP CONSTRAINT IF EXISTS "repository_connections_projectId_key";

-- Create the enums
CREATE TYPE "ProjectOwnerType" AS ENUM ('user', 'organization');
CREATE TYPE "ProjectVisibility" AS ENUM ('public', 'private');
CREATE TYPE "ProjectStatus" AS ENUM ('active', 'archived', 'deleted');

-- Add new enum columns
ALTER TABLE "projects" 
  ADD COLUMN "ownerTypeEnum" "ProjectOwnerType",
  ADD COLUMN "visibilityEnum" "ProjectVisibility",
  ADD COLUMN "statusEnum" "ProjectStatus";

-- Migrate existing data
UPDATE "projects" SET 
  "ownerTypeEnum" = "ownerType"::"ProjectOwnerType",
  "visibilityEnum" = "visibility"::"ProjectVisibility",
  "statusEnum" = "status"::"ProjectStatus";

-- Set default values for new columns
ALTER TABLE "projects" 
  ALTER COLUMN "ownerTypeEnum" SET DEFAULT 'user',
  ALTER COLUMN "visibilityEnum" SET DEFAULT 'private',
  ALTER COLUMN "statusEnum" SET DEFAULT 'active';

-- Drop old columns
ALTER TABLE "projects"
  DROP COLUMN "ownerType",
  DROP COLUMN "visibility",
  DROP COLUMN "status";

-- Rename new columns to original names
ALTER TABLE "projects"
  RENAME COLUMN "ownerTypeEnum" TO "ownerType";
ALTER TABLE "projects"
  RENAME COLUMN "visibilityEnum" TO "visibility";
ALTER TABLE "projects"
  RENAME COLUMN "statusEnum" TO "status";

-- Recreate foreign key constraints
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_project_id_fkey" 
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_projectId_key" 
  UNIQUE ("projectId"); 