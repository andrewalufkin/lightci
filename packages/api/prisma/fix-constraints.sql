-- Drop dependent foreign key constraints first
ALTER TABLE IF EXISTS "pipelines" DROP CONSTRAINT IF EXISTS "pipelines_project_id_fkey";

-- Drop primary key constraint
ALTER TABLE IF EXISTS "projects" DROP CONSTRAINT IF EXISTS "projects_pkey";

-- Drop other project-related constraints
ALTER TABLE IF EXISTS "projects" DROP CONSTRAINT IF EXISTS "projects_org_owner_fkey";
ALTER TABLE IF EXISTS "projects" DROP CONSTRAINT IF EXISTS "projects_user_owner_fkey";

-- Drop repository connection constraints
ALTER TABLE IF EXISTS "repository_connections" DROP CONSTRAINT IF EXISTS "repository_connections_organization_id_fkey";
ALTER TABLE IF EXISTS "repository_connections" DROP CONSTRAINT IF EXISTS "repository_connections_user_id_fkey"; 