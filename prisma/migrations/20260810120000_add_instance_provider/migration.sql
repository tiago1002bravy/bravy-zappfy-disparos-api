-- CreateEnum
CREATE TYPE "InstanceProvider" AS ENUM ('UAZAPI', 'CLOUD_API');

-- AlterTable
ALTER TABLE "Instance" ADD COLUMN     "provider" "InstanceProvider" NOT NULL DEFAULT 'UAZAPI',
ADD COLUMN     "phoneNumberId" TEXT,
ADD COLUMN     "wabaId" TEXT,
ADD COLUMN     "displayPhoneNumber" TEXT,
ADD COLUMN     "dailyCap" INTEGER;

-- CreateIndex
CREATE INDEX "Instance_tenantId_provider_active_idx" ON "Instance"("tenantId", "provider", "active");

-- CreateIndex
CREATE INDEX "Execution_tenantId_instanceName_ranAt_idx" ON "Execution"("tenantId", "instanceName", "ranAt");

-- CreateIndex
CREATE INDEX "Execution_tenantId_status_ranAt_idx" ON "Execution"("tenantId", "status", "ranAt");
