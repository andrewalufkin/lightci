-- Add unique constraint to deployed_apps
ALTER TABLE "deployed_apps" ADD CONSTRAINT "deployed_apps_pipelineId_environment_key" UNIQUE ("pipeline_id", "environment"); 