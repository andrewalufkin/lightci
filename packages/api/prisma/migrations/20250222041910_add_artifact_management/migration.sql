-- AlterTable
ALTER TABLE "pipelines" ADD COLUMN     "artifact_patterns" JSONB DEFAULT '[]',
ADD COLUMN     "artifact_retention_days" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "artifact_storage_config" JSONB DEFAULT '{}',
ADD COLUMN     "artifact_storage_type" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "artifacts_enabled" BOOLEAN NOT NULL DEFAULT true;
