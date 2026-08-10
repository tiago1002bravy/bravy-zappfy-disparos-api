-- CreateEnum
CREATE TYPE "CampaignMode" AS ENUM ('ONESHOT', 'CONTINUOUS');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "chatRegisterDbUrlEnc" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "mode" "CampaignMode" NOT NULL DEFAULT 'ONESHOT',
ADD COLUMN     "flowId" TEXT,
ALTER COLUMN "templateId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "CampaignMessage" ADD COLUMN     "templateName" TEXT,
ADD COLUMN     "flowContext" JSONB;

-- CreateTable
CREATE TABLE "Flow" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "instanceId" TEXT NOT NULL,
    "everyMinutes" INTEGER,
    "times" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "config" JSONB NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Flow_tenantId_slug_key" ON "Flow"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "Flow_tenantId_active_idx" ON "Flow"("tenantId", "active");

-- CreateIndex
CREATE INDEX "Campaign_flowId_createdAt_idx" ON "Campaign"("flowId", "createdAt");

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
