-- AlterTable
ALTER TABLE "pipelines" ALTER COLUMN "steps" SET DEFAULT '[]',
ALTER COLUMN "triggers" SET DEFAULT '{}',
ALTER COLUMN "schedule" SET DEFAULT '{}';
