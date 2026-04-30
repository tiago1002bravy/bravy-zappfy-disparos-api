-- AlterTable
ALTER TABLE "Group" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "Group_tenantId_instanceName_active_idx" ON "Group"("tenantId", "instanceName", "active");
