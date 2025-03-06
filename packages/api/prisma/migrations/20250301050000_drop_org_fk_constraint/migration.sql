-- Drop foreign key constraints first
ALTER TABLE "pipelines" DROP CONSTRAINT IF EXISTS "pipelines_project_id_fkey" CASCADE;

-- Drop primary key constraint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_pkey" CASCADE;

-- Add new primary key constraint
ALTER TABLE "projects" ADD PRIMARY KEY ("id");

-- Recreate foreign key constraints
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;

-- Add a comment explaining the change
COMMENT ON TABLE "projects" IS 'Projects table with polymorphic relationship to users or organizations. Foreign key validation for organizations is handled at the application level.'; 