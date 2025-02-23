-- AlterTable
ALTER TABLE "pipeline_runs" ADD COLUMN     "artifacts_collected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "artifacts_count" INTEGER,
ADD COLUMN     "artifacts_expire_at" TIMESTAMP(3),
ADD COLUMN     "artifacts_path" TEXT,
ADD COLUMN     "artifacts_size" INTEGER;
