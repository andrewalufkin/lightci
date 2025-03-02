-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "default_branch" TEXT,
ADD COLUMN     "last_build_at" TIMESTAMP(3),
ADD COLUMN     "settings" JSONB DEFAULT '{}',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'private';
