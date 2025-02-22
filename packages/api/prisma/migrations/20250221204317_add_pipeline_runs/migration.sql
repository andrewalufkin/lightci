-- CreateTable
CREATE TABLE "pipeline_runs" (
    "id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "branch" TEXT NOT NULL,
    "commit" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "stepResults" JSONB NOT NULL DEFAULT '[]',
    "logs" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,

    CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
