-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_org_owner_fkey";

-- DropForeignKey
ALTER TABLE "projects" DROP CONSTRAINT "projects_user_owner_fkey";

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_owner_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
