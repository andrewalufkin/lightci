-- Create usage_records table if it doesn't exist
CREATE TABLE IF NOT EXISTS "usage_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "organization_id" TEXT,
    "usage_type" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB DEFAULT '{}',
    "pipeline_run_id" TEXT,
    "project_id" TEXT,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- Add foreign key constraints
ALTER TABLE "usage_records" DROP CONSTRAINT IF EXISTS "usage_records_user_id_fkey";
ALTER TABLE "usage_records" DROP CONSTRAINT IF EXISTS "usage_records_organization_id_fkey";
ALTER TABLE "usage_records" DROP CONSTRAINT IF EXISTS "usage_records_pipeline_run_id_fkey";
ALTER TABLE "usage_records" DROP CONSTRAINT IF EXISTS "usage_records_project_id_fkey";

ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_pipeline_run_id_fkey"
    FOREIGN KEY ("pipeline_run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE; 