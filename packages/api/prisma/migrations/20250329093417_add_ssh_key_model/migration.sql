-- AlterTable
ALTER TABLE "auto_deployments" ADD COLUMN     "ssh_key_id" TEXT;

-- CreateTable
CREATE TABLE "ssh_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "encoded_content" TEXT NOT NULL,
    "key_pair_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ssh_keys_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "auto_deployments" ADD CONSTRAINT "auto_deployments_ssh_key_id_fkey" FOREIGN KEY ("ssh_key_id") REFERENCES "ssh_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
