-- CreateTable
CREATE TABLE "Instance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,
    "instanceTokenEnc" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastFailedAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Instance_tenantId_instanceName_key" ON "Instance"("tenantId", "instanceName");

-- CreateIndex
CREATE INDEX "Instance_tenantId_active_priority_idx" ON "Instance"("tenantId", "active", "priority");

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add instanceName to Execution for tracking which instance delivered
ALTER TABLE "Execution" ADD COLUMN "instanceName" TEXT;
