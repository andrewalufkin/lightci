-- Make project_id optional in deployed_apps table
ALTER TABLE "deployed_apps" ALTER COLUMN "project_id" DROP NOT NULL;

-- Drop and recreate the foreign key constraint to allow null values
ALTER TABLE "deployed_apps" DROP CONSTRAINT "deployed_apps_project_id_fkey";
ALTER TABLE "deployed_apps" ADD CONSTRAINT "deployed_apps_project_id_fkey" 
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE; 