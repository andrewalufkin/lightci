-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "email_low_balance" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "email_weekly_usage" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "credit_balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "payment_history" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "usage_history" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "billing_periods" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "organization_id" TEXT,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "usage_summary" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_periods_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
