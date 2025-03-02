/*
  Warnings:

  - You are about to drop the column `organization_id` on the `projects` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `projects` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_organization_id_fkey";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";

-- AlterTable
ALTER TABLE "projects" DROP COLUMN "organization_id",
DROP COLUMN "user_id";

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
