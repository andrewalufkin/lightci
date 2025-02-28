-- AlterTable
ALTER TABLE "pipelines" ADD COLUMN     "webhook_config" JSONB DEFAULT '{}';
