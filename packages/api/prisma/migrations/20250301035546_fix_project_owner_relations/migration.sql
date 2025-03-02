/*
  Warnings:

  - The primary key for the `projects` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `created_at` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `default_branch` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `last_build_at` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `owner_id` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `owner_type` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `projects` table. All the data in the column will be lost.
  - The `id` column on the `projects` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `repository_connections` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `access_token_encrypted` on the `repository_connections` table. All the data in the column will be lost.
  - You are about to drop the column `created_at` on the `repository_connections` table. All the data in the column will be lost.
  - You are about to drop the column `git_provider` on the `repository_connections` table. All the data in the column will be lost.
  - You are about to drop the column `organization_id` on the `repository_connections` table. All the data in the column will be lost.
  - You are about to drop the column `repository_url` on the `repository_connections` table. All the data in the column will be lost.
  - You are about to drop the column `updated_at` on the `repository_connections` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `repository_connections` table. All the data in the column will be lost.
  - You are about to drop the column `webhook_id` on the `repository_connections` table. All the data in the column will be lost.
  - You are about to drop the column `webhook_secret` on the `repository_connections` table. All the data in the column will be lost.
  - The `id` column on the `repository_connections` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[projectId]` on the table `repository_connections` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `ownerId` to the `projects` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `projects` table without a default value. This is not possible if the table is not empty.
  - Made the column `settings` on table `projects` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `projectId` to the `repository_connections` table without a default value. This is not possible if the table is not empty.
  - Added the required column `provider` to the `repository_connections` table without a default value. This is not possible if the table is not empty.
  - Added the required column `repositoryUrl` to the `repository_connections` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `repository_connections` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_org_owner_fkey";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_user_owner_fkey";

-- DropForeignKey
ALTER TABLE "repository_connections" DROP CONSTRAINT "repository_connections_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "repository_connections" DROP CONSTRAINT "repository_connections_user_id_fkey";

-- DropIndex
DROP INDEX "projects_name_owner_id_owner_type_key";

-- DropIndex
DROP INDEX "projects_owner_id_owner_type_idx";

-- AlterTable
ALTER TABLE "projects" DROP CONSTRAINT "projects_pkey",
DROP COLUMN "created_at",
DROP COLUMN "default_branch",
DROP COLUMN "last_build_at",
DROP COLUMN "owner_id",
DROP COLUMN "owner_type",
DROP COLUMN "updated_at",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "defaultBranch" TEXT NOT NULL DEFAULT 'main',
ADD COLUMN     "ownerId" UUID NOT NULL,
ADD COLUMN     "ownerType" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
ALTER COLUMN "settings" SET NOT NULL,
ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "repository_connections" DROP CONSTRAINT "repository_connections_pkey",
DROP COLUMN "access_token_encrypted",
DROP COLUMN "created_at",
DROP COLUMN "git_provider",
DROP COLUMN "organization_id",
DROP COLUMN "repository_url",
DROP COLUMN "updated_at",
DROP COLUMN "user_id",
DROP COLUMN "webhook_id",
DROP COLUMN "webhook_secret",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "organizationId" UUID,
ADD COLUMN     "projectId" UUID NOT NULL,
ADD COLUMN     "provider" TEXT NOT NULL,
ADD COLUMN     "repositoryUrl" TEXT NOT NULL,
ADD COLUMN     "settings" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "userId" UUID,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
ADD CONSTRAINT "repository_connections_pkey" PRIMARY KEY ("id");

-- CreateIndex
CREATE INDEX "projects_ownerId_idx" ON "projects"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "repository_connections_projectId_key" ON "repository_connections"("projectId");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_owner_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_owner_fkey" FOREIGN KEY ("ownerId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_connections" ADD CONSTRAINT "repository_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
