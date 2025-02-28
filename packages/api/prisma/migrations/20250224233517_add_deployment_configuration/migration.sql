-- AlterTable
ALTER TABLE "pipelines" ADD COLUMN     "deployment_config" JSONB DEFAULT '{}',
ADD COLUMN     "deployment_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deployment_platform" TEXT;
