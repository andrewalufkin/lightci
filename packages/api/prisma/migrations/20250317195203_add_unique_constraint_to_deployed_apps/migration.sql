/*
  Warnings:

  - A unique constraint covering the columns `[pipeline_id,environment]` on the table `deployed_apps` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "deployed_apps_pipeline_id_environment_key" ON "deployed_apps"("pipeline_id", "environment");
