-- Drop the organization foreign key constraint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_org_owner_fkey";

-- Add a comment explaining the change
COMMENT ON TABLE "projects" IS 'Projects table with polymorphic relationship to users or organizations. Foreign key validation for organizations is handled at the application level.'; 